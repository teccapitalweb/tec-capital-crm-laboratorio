# Guía: tu primer recorrido de venta de curso

Un **recorrido** es una conversación automática: saluda, manda la información del curso, espera, pregunta con botones, pide un dato y pasa con una persona del equipo. Se arma en **Automatización** (menú WhatsApp), se revisa, se prueba sin enviar nada y sólo atiende cuando lo publicas **y** lo activas. Mientras la pantalla esté en vista previa, sólo la ve quien tiene la vista previa encendida.

## 1. Crear el recorrido

1. Entra a **Automatización**. Verás la lista de recorridos de la marca (si tienes varias, elige la marca arriba).
2. Pulsa **Nuevo recorrido**, escribe un nombre (por ejemplo «Venta de curso») y elige **Plantilla de ejemplo «Venta de curso»**. Trae listo: saludo, ficha del curso con su flyer, una espera corta, botones «Sí, me interesa / Ver el temario / Hablar con alguien», inscripción, pregunta del correo y pasar con una persona.
3. Un mismo recorrido sirve para todos los cursos de la marca: el curso es el de la conversación y su precio, fechas y flyer salen siempre del catálogo vigente.

## 2. Ajustarlo a tu marca

- En computadora trabajas en el **lienzo** (cajas y flechas) o en el **esquema** (los pasos en orden). En celular se edita en el esquema.
- Haz clic en un paso para cambiar su texto a la derecha. Para agregar uno, elígelo en la columna «Agregar paso»; si tienes un paso seleccionado, el nuevo queda conectado después de él. En el esquema, cada salida tiene una lista «a dónde lleva»: ahí puedes conectar con otro paso o crear uno nuevo en ese punto.
- Los tipos que dicen **«Todavía no disponible»** (Suscribir, Servicio externo, «¿Qué curso te interesa?») aún no se pueden publicar; algunas opciones de otros pasos tampoco (por ejemplo, «Material según el curso»), y el paso lo marca en rojo en cuanto la eliges.
- **Más de tres opciones: Lista.** Hasta 10 filas, en secciones si quieres. En WhatsApp real la persona ve el botón (por ejemplo «Ver cursos») y elige una fila; en el chat de prueba ve las opciones numeradas. En los dos casos puede contestar con el número o escribiendo la opción.
- **Guardar lo que eligió.** En Botones y en Lista, «Guardar la opción elegida en la variable» guarda el texto del botón o de la fila; lo usas después como `{{var.nombre}}` o en una Condición.
- **Archivos.** En un Mensaje elige «Archivo» (o «Archivo» como encabezado de Botones) y escoge una imagen JPG o PNG o un PDF de la biblioteca de la marca, o pulsa **Subir archivo**. Sólo aparecen los archivos de esa marca.
- **Plantilla de WhatsApp.** Elige una plantilla de la marca aprobada por Meta. Sale sólo por el número real de WhatsApp, con los datos de la persona, y es lo único que sale aunque hayan pasado más de 24 horas desde su último mensaje. Si la marca no tiene número real, o el recorrido también va por Instagram o Facebook, la revisión no deja publicarla. En una conversación de prueba no se envía: la conversación pasa a una persona.
- **Ajustes** (arriba): el nombre, **cómo empieza** (a mano desde el chat, con el primer mensaje, con una palabra clave o con cualquier mensaje) y cuánto esperar antes de dar la conversación por abandonada.
- Pulsa **Guardar** (o Ctrl+S). La barra dice «Sin guardar» mientras haya cambios. Si otra persona guardó el mismo recorrido mientras lo editabas, el CRM te avisa y **no pisa nada**: tus cambios siguen en pantalla y tú eliges.

## 3. Revisar

Pulsa **Revisar**. Verás una lista en palabras claras:

- **Impide publicar**: hay que corregirlo (un mensaje vacío, un botón sin texto, un tipo de paso no disponible…).
- **Recomendación**: se puede publicar, pero conviene mirarlo (por ejemplo, una salida sin conectar).

Cada punto tiene **Ir al paso**, que te lleva directo a él.

## 4. Probar

Pulsa **Probar**. Es una conversación de ensayo con **el mismo motor que atenderá de verdad** y el catálogo real de la marca. Elige el curso y el canal, pulsa los botones o las filas de una lista, o escribe como si fueras la persona. Los archivos aparecen con su nombre y una plantilla de WhatsApp con datos de ejemplo. **No se envía nada a nadie ni se guarda nada.** Se prueba lo que ves en pantalla, aunque no lo hayas guardado.

## 5. Publicar y activar

1. **Publicar** guarda lo que hay (si falta), lo revisa y te pide confirmar. Lo publicado queda como una **versión** (1, 2, 3…), que ves en la pestaña **Versiones**.
2. Las conversaciones que ya iban en el recorrido **siguen con la versión con la que empezaron**; las nuevas usan la recién publicada.
3. **Activar** hace que empiece a atender, siempre que la automatización de la marca esté encendida y su asistente responda solo. **Pausar** deja de empezar con gente nueva (y, si lo eliges, detiene las conversaciones en curso). **Archivar** lo retira; su historial se conserva.

### Si lo activaste y no contesta

Un recorrido activo sólo atiende si **la marca está atendiendo con recorridos**. Si no, la lista y el recorrido lo dicen con un aviso amarillo, el estado aparece como «Activo, pero la marca no está atendiendo» y la ventana de «Activar» te lo advierte antes de confirmar. Mientras tanto contesta el asistente de siempre. Hay tres motivos, y los tres se arreglan en **Operación → Ventas y cobro → Seguimientos**:

- **La automatización de la marca está apagada:** en la sección «Automatización», pulsa «Activar» en la marca.
- **La automatización está en pausa para todas las marcas:** en esa misma sección, quita la pausa global.
- **El asistente no responde solo:** en «Respuestas automáticas a clientes», cambia el «Nivel de respuestas» de la marca a «Responder con plantillas» o «Autónomo con IA» («Apagado» y «Sugerir al asesor» no contestan solos).

Si además ves «El modo real de esta marca está apagado», es sólo información: los recorridos atienden igual, también por WhatsApp real, pero sus mensajes llevan los avisos de prueba («Chat de prueba…», «Pago de prueba…»). Para atender clientes de verdad sin esos avisos, enciende el modo real de la marca en Operación → Ventas y cobro → Pagos ([PLAN_MODO_REAL.md](PLAN_MODO_REAL.md)).

## 6. Leer su rendimiento

En la pestaña **Rendimiento**, elige el periodo (7, 30 o 90 días) y la versión:

- **Empezaron, terminaron, pasaron con una persona, se fueron y en curso.**
- **Dónde se pierde gente**, lo más débil primero: «El 62 % se va en el paso 4, “¿Te gustaría inscribirte?”». Con **Ver en el recorrido** las cifras aparecen sobre cada paso del lienzo o del esquema.
- **Paso por paso**: cuántas conversaciones llegaron, cuántas siguieron, cuántas se fueron ahí y cuánto tardan en contestar (la mediana).
- **Cómo terminaron**: terminó el recorrido, pasó con una persona, una persona tomó el chat, dejó de contestar, escribió otra cosa, error.

Las cifras son conteos: no muestran nombres, teléfonos ni lo que escribió nadie.

## 7. Sugerencias

En Rendimiento, **Pedir sugerencias** revisa el recorrido y sus cifras y propone mejoras ligadas a un paso: mensajes demasiado largos, preguntas sin salida, pasos donde se va la gente, falta de «pasar con una persona», tono. Hay dos fuentes: la **revisión automática** (siempre) y la **IA** (si está configurada y no se alcanzó el tope mensual de la IA; si no, lo dice). A la IA sólo se le manda la estructura del recorrido y las cifras por paso, **nunca** datos de personas ni conversaciones. Las sugerencias **no cambian nada**: tú decides qué aplicar.

Detalle técnico: [PLAN_RECORRIDOS.md](PLAN_RECORRIDOS.md).
