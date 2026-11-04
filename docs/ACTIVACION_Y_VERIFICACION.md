# Activación y verificación en producción

Runbook para dejar **una marca de pruebas** funcionando de punta a punta, comprobar cada módulo con datos propios identificados y volver todo a su estado. Es lo que falta de verificación: hasta hoy la producción sólo se verificó **sin sesión** (archivos servidos, rutas protegidas con 401, `/api/health`, CI). Qué hace cada pantalla: [GUIA_DE_USO.md](GUIA_DE_USO.md). Interruptores y límites: [ESTADO_ACTUAL.md](ESTADO_ACTUAL.md).

## Reglas

- Una **marca de pruebas** (por ejemplo la que menos peso comercial tenga) y registros propios que **empiecen con «PRUEBA ·»** (clientes, campañas, tareas, plantillas).
- No cambiar precios, ediciones, conversaciones ni configuración comercial reales para facilitar la prueba.
- No usar números ni datos de personas reales. Los pagos y canales son simulados.
- Al terminar: apagar lo que se encendió, cerrar seguimientos, cancelar campañas y archivar materiales de prueba (sección «Cierre»).
- Se necesita una **sesión de administración** (en Chrome o en el navegador de la aplicación). Las contraseñas y el código de invitación los teclea la persona, no se comparten por chat.

## A. Preparación (5 min)

1. Entrar en `/crm` con la cuenta de administración y comprobar que el menú del equipo tiene **Mis resultados** y que **Operación** muestra las pestañas Cola, Avisos, Horarios, Macros, Pagos, Coordinación, Certificados, Finanzas, Seguimientos, **Campañas**, Demo, Conectores, Eventos e Históricos.
2. Elegir la marca de pruebas en el selector de marca.
3. En **Mi configuración → Acceso y seguridad** (opcional) activar la verificación en dos pasos de la cuenta.
4. Confirmar en `/api/health` la versión publicada y en [ESTADO_ACTUAL.md](ESTADO_ACTUAL.md) que coincide.

## B. Orden de encendido (marca de pruebas)

| # | Dónde | Qué encender |
| --- | --- | --- |
| 1 | Operación → Seguimientos | **Activar** la automatización de la marca |
| 2 | Seguimientos → «Respuestas automáticas a clientes» | Nivel **Responder con plantillas** (o **Sugerir** para ver borradores) |
| 3 | Seguimientos → Canal simulado | **Activo** (estados de entrega y ventana de 24 h) |
| 4 | Operación → Pagos | **Activa** |
| 5 | Operación → Coordinación → «Automatización por marca» | **Automatización activa** y **Abrir al llegar al mínimo** |
| 6 | Operación → Certificados → «Emisión por marca» | **Emitir al cerrar la apertura** (asistencia mínima por omisión) |
| 7 | Operación → Campañas | **Encender** la marca |
| 8 | Operación → Finanzas → Reglas | Una regla de comisión **de prueba** para vendedor |

Dejar apagado lo demás (créditos de certificados, cobro de sesiones, encuesta automática) hasta que se pruebe aparte.

## C. Recorrido de verificación (~40 min)

Cada paso termina con un **resultado esperado**; si no ocurre, detenerse y anotar el paso, la hora y el mensaje que mostró la pantalla.

1. **Cliente de prueba.** Operación → **Demo** crea clientes ficticios («· demo»); o crear un perfil «PRUEBA · cliente» en `/` y abrir una conversación sobre un curso de la marca. *Esperado:* la conversación aparece en la bandeja del equipo y el cliente recibe la bienvenida con precio y fecha del catálogo.
2. **Atención y canal.** Escribir como cliente y responder como asesor. *Esperado:* los mensajes del equipo pasan por enviado → entregado → leído; pedir un asesor manda el chat a la cola.
3. **Cobro y pago simulado.** En el chat, **Cobrar**; pagar como cliente con tarjeta simulada. *Esperado:* el pedido pasa a pagado, la oportunidad queda **ganada**, hay inscripción y un aviso a quien coordina.
4. **Apertura.** Operación → Coordinación. *Esperado:* la inscripción aparece sola en la apertura de la edición; designar un responsable.
5. **Sesión y asistencia.** Programar una sesión (con enlace simulado), registrar asistencia y marcarla realizada. *Esperado:* el recordatorio llega a los inscritos y la asistencia queda en la bitácora de Eventos.
6. **Cierre y certificado.** Cerrar la apertura. *Esperado:* se emite un certificado con folio IPCI secuencial; abrirlo en una ventana **sin sesión** (`/verificar/<folio>`) muestra estado, curso y nombre abreviado; el SVG del QR se descarga.
7. **Encuesta.** Enviar la encuesta de la sesión; responderla con el enlace público. *Esperado:* aparecen respuestas y promedios en la apertura.
8. **Finanzas.** Operación → Finanzas. *Esperado:* el libro tiene la venta, la **conciliación** dice «correcta» y el total coincide con el del Modo presentación para el mismo periodo; devengar comisiones pendientes crea la comisión de vendedor.
9. **Mis resultados.** Como el asesor dueño de la oportunidad: ventas netas y comisión pendiente iguales a Finanzas. Como administración con **Ver a**: lo mismo para esa persona. *Esperado:* otra persona del equipo **no** ve esas ventas.
10. **Rendimiento del equipo** (administración, al final de Mis resultados). *Esperado:* una fila por persona con ventas netas, cierre, tareas vencidas, primera respuesta y avisos; el botón **Ver** abre su portal.
11. **Campaña.** Operación → Campañas → Nueva campaña con una plantilla **aprobada** de la marca de pruebas y un público acotado (una etiqueta «PRUEBA»). Calcular la vista previa, programar confirmando el número. *Esperado:* los enviados coinciden con la vista previa, quien tiene baja no recibe, y el detalle muestra entregados, respuestas y bajas; una segunda campaña inmediata al mismo contacto queda excluida por «Recibió otra campaña hace poco».
12. **Baja.** Responder «baja» como un cliente de prueba. *Esperado:* el consentimiento pasa a «no desea» y deja de recibir campañas y seguimientos.
13. **Modo presentación.** *Esperado:* el guion de 13 pasos marca «Listo» en lo que se acaba de probar y «Preparar» en lo que siga apagado.
14. **Móvil.** Repetir 1, 9 y 11 en un teléfono (o 375 px). *Esperado:* sin desplazamiento horizontal de la página y botones tocables.

15. **Notificaciones push (en un teléfono real).** Con la cuenta de prueba, Mi configuración → Activar → Enviar prueba. Desde otra cuenta asignar un chat a esa persona y, sin abrir el CRM en el teléfono, esperar unos 20 s. *Esperado:* llega la notificación con la marca y el texto del aviso; tocarla abre o enfoca el CRM; al desactivar el dispositivo deja de llegar. **Es la única parte que el laboratorio no pudo probar**: aquí se confirma la entrega real.

16. **Respuestas rápidas y Recordarme.** Con la cuenta de prueba, crear la respuesta personal `/gracias` con `{{nombre}}` y `{{curso}}`; en un chat de la marca de pruebas escribir `/gr` y elegirla con Enter. *Esperado:* el texto queda en el compositor con el nombre del cliente de prueba y **no se envía**; **Recordarme → En 1 hora** crea una tarea que aparece en Mi día. Como administración, crear una respuesta compartida de la marca y comprobar que otra persona de esa marca la ve. Archivar las respuestas de prueba al terminar.

## D. Cierre y limpieza

1. Cancelar toda campaña de prueba que siga programada o enviando.
2. Cerrar las conversaciones y tareas de prueba; archivar o pausar plantillas, recetas y materiales «PRUEBA ·».
3. Revocar los certificados de prueba (Operación → Certificados) para que su verificación pública diga «revocado».
4. **Apagar** en orden inverso al de la sección B todo lo que se encendió, quitar la regla de comisión de prueba y desactivar las notificaciones push del dispositivo de prueba.
5. Anotar en [CONTINUIDAD.md](CONTINUIDAD.md) la fecha, quién verificó, qué pasos pasaron y cuáles fallaron, con el resultado de `/api/health` y la versión.

No se borran datos: los registros de prueba quedan identificados y apagados.

## E. Si algo sale mal

| Situación | Acción |
| --- | --- |
| Se envía algo que no debía | Seguimientos → **Pausar todo** (detiene todos los pasos de todas las marcas sin perderlos); luego apagar la marca y cancelar la campaña |
| Una campaña sigue enviando | Campañas → **Cancelar** (detiene lo que falta; lo enviado se conserva) |
| Un chat recibe respuestas automáticas indebidas | **Tomar chat** en esa conversación o bajar el nivel de respuestas de la marca a «Apagado» |
| Datos en mal estado | Respaldo automático en `backups/` del volumen y copia previa a cada migración (`before-crm-v26-*`); restauración según [OPERACION_Y_PRUEBAS.md](OPERACION_Y_PRUEBAS.md) |
| Versión equivocada publicada | Volver al commit anterior en `main` (avance controlado) y verificar `/api/health`; ningún cambio de esquema es destructivo |

## F. Qué queda fuera de esta verificación

Meta, pasarela, correo, calendario y IA reales: dependen de accesos y claves de las consultoras o del usuario ([ESTADO_ACTUAL.md](ESTADO_ACTUAL.md), «Qué necesita una decisión o un acceso tuyo»).
