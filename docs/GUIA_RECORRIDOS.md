# Guía: tu primer recorrido de venta de curso

Un **recorrido** es una conversación automática: saluda, manda la información del curso, espera, pregunta con botones, pide un dato y pasa con una persona del equipo. Se arma en **Automatización** (menú WhatsApp), se revisa, se prueba sin enviar nada y sólo atiende cuando lo publicas **y** lo activas. Mientras la pantalla esté en vista previa, sólo la ve quien tiene la vista previa encendida.

## 1. Crear el recorrido

1. Entra a **Automatización**. Verás una tarjeta por recorrido de la marca, con su estado, cómo empieza, la versión publicada, cuántas conversaciones van en él y cómo les fue, y sus botones (**Abrir**, **Duplicar**, **Activar** o **Pausar**, **Archivar**). Si tienes varias marcas, elígela arriba; ahí mismo se dice si la marca está atendiendo con recorridos.
2. Pulsa **Nuevo recorrido**, escribe un nombre (por ejemplo «Venta de curso») y elige **Plantilla de ejemplo «Venta de curso»**. Trae listo: saludo, ficha del curso con su flyer, una espera corta, botones «Sí, me interesa / Ver el temario / Hablar con alguien», inscripción, pregunta del correo y pasar con una persona.
3. Un mismo recorrido sirve para todos los cursos de la marca: el curso es el de la conversación y su precio, fechas y flyer salen siempre del catálogo vigente.

## 2. Ajustarlo a tu marca

El editor abre en **Pasos**, en computadora y en celular. Arriba, en un solo renglón cuando cabe, están las pestañas (Editar, Rendimiento, Versiones) y las herramientas (Pasos/Lienzo, deshacer, rehacer, problemas, Rendimiento, Probar, Guardar). Los avisos de la marca («no está atendiendo con recorridos», modo real) van en tiras de un renglón: pulsa **Por qué y dónde se enciende** o **Más** para leerlos completos. En computadora el editor ocupa lo que queda de la ventana, así ves los pasos, el paso elegido y el teléfono sin desplazar la página. Es la manera rápida de armar un recorrido:

- **A la izquierda, los pasos en orden**, numerados, como los vive la persona. Cada tarjeta tiene el color de su clase de paso, y el color quiere decir siempre lo mismo: **cielo** un mensaje, **menta** botones, **lila** una lista, **durazno** la persona (una pregunta que contesta ella, o pasarla con alguien del equipo), **mantequilla** el catálogo (ficha, precio, temario, fechas, elegir curso), **lima** la inscripción con enlace de pago y **blanco** lo demás (Inicio, esperas, condiciones, datos, etiquetas, Fin…). Si un paso tiene varias salidas (botones, lista, condición), su tarjeta dice a dónde lleva cada una; pulsa el destino para ir a ese paso.
- **En el centro, el paso que elegiste**, con todos sus campos. En botones y listas, cada opción va en su renglón y, al lado, **a dónde sigue**, pintado con el color del paso de destino; ahí mismo la cambias, la dejas sin conectar o creas un paso nuevo en ese punto. Arriba están **Duplicar** y **Eliminar**.
- **A la derecha, «Así lo ve la persona»**: un teléfono con la conversación hasta el paso que elegiste, con lo que contesta la persona para llegar ahí. Se arma con lo que hay en pantalla aunque no lo hayas guardado, y no envía nada. Lo que se arma al enviar con los datos vigentes del curso (ficha, precio, fechas…) aparece dicho en palabras, sin inventar el mensaje. En celular (o en una ventana angosta) se abre con el botón **Así lo ve la persona**, abajo del paso.
- **Agregar paso** (abajo de la lista; en celular, el botón **Agregar** de la barra): primero los mensajes (Mensaje, Botones, Lista, Pregunta, Plantilla de WhatsApp); el resto, con **Ver todos los tipos de paso**. El paso nuevo **siempre queda conectado**: va después del paso que tienes elegido o, si no tienes ninguno, al final del camino. Si lo metes entre dos pasos, queda en medio (A → nuevo → B), y si el nuevo tiene varias opciones (botones, lista), todas llevan a B para que ninguna quede colgando. Cambias a dónde lleva cada una en el centro.
- **Agregar una fila o un botón** a un paso cuyas opciones llevan todas al mismo paso: la nueva lleva ahí también. Si ya iban a sitios distintos, se queda sin conectar y la tarjeta te lo dice.
- **Eliminar un paso de en medio no deja varado lo que sigue.** Si el paso lleva a un solo sitio (una sola salida, o todas sus opciones al mismo paso), lo que llegaba a él pasa a llegar a ese sitio: A → paso → B queda A → B. Si sus opciones iban a sitios distintos, el CRM no adivina: lo elimina y te dice qué pasos quedaron sin camino, con **Ir al paso**. En los dos casos **Deshacer** lo devuelve todo de un golpe. Funciona igual en Pasos y en el Lienzo (botón Eliminar, la papelera de la tarjeta, Supr o cortar).
- **Lo que falta, dicho en el propio paso.** Una tarjeta avisa en palabras «Ningún camino llega a este paso», «La salida “Precio” no está conectada…» o que el mensaje está vacío. La pastilla de la barra (por ejemplo «2 avisos») abre la lista completa, cada uno con **Ir al paso**.
- **Lienzo** (junto a «Pasos», arriba) es el mismo recorrido en cajas y flechas, con todo lo de siempre: arrastrar, conectar, acomodar, acercar y alejar, el minimapa, selección múltiple y atajos de teclado. El editor recuerda la última vista que elegiste mientras la aplicación esté abierta. En el lienzo, arrastrar un tipo de paso al fondo lo deja **suelto** donde lo sueltas (y la tarjeta lo avisa hasta que lo conectes); un clic en la paleta lo agrega conectado, igual que en Pasos.
- Los tipos que dicen **«Todavía no disponible»** (Suscribir, Servicio externo, «¿Qué curso te interesa?») aún no se pueden publicar; algunas opciones de otros pasos tampoco (por ejemplo, «Material según el curso»), y el paso lo marca en rojo en cuanto la eliges.
- **Más de tres opciones: Lista.** Hasta 10 filas, en secciones si quieres. En WhatsApp real la persona ve el botón (por ejemplo «Ver cursos») y elige una fila; en el chat de prueba ve las opciones numeradas. En los dos casos puede contestar con el número o escribiendo la opción.
- **Guardar lo que eligió.** En Botones y en Lista, «Guardar la opción elegida en la variable» guarda el texto del botón o de la fila; lo usas después como `{{var.nombre}}` o en una Condición.
- **Archivos.** En un Mensaje elige «Archivo» (o «Archivo» como encabezado de Botones) y escoge una imagen JPG o PNG o un PDF de la biblioteca de la marca, o pulsa **Subir archivo**. Sólo aparecen los archivos de esa marca.
- **Plantilla de WhatsApp.** Elige una plantilla de la marca aprobada por Meta. Sale sólo por el número real de WhatsApp, con los datos de la persona, y es lo único que sale aunque hayan pasado más de 24 horas desde su último mensaje. Si la marca no tiene número real, o el recorrido también va por Instagram o Facebook, la revisión no deja publicarla. En una conversación de prueba no se envía: la conversación pasa a una persona.
- **Ajustes** (arriba): el nombre, **cómo empieza** (a mano desde el chat, con el primer mensaje, con una palabra clave o con cualquier mensaje) y cuánto esperar antes de dar la conversación por abandonada. **Ojo:** lo que atiende es la versión publicada. Si el recorrido ya está publicado y cambias cómo empieza o los tiempos, el cambio queda en el borrador: al guardar los ajustes el CRM te lo dice («todavía no en servicio») y te ofrece **Publicar ahora**; mientras no publiques, un aviso amarillo arriba del editor lo recuerda.
- Pulsa **Guardar** (o Ctrl+S). La barra dice «Sin guardar» mientras haya cambios. Si otra persona guardó el mismo recorrido mientras lo editabas, el CRM te avisa y **no pisa nada**: tus cambios siguen en pantalla y tú eliges.

## 3. Revisar

Pulsa **Revisar**. Verás una lista en palabras claras:

- **Impide publicar**: hay que corregirlo (un mensaje vacío, un botón sin texto, un tipo de paso no disponible…).
- **Recomendación**: se puede publicar, pero conviene mirarlo (por ejemplo, una salida sin conectar).

Cada punto tiene **Ir al paso**, que te lleva directo a él.

## 4. Probar

Pulsa **Probar**. Es una conversación de ensayo con **el mismo motor que atenderá de verdad** y el catálogo real de la marca. Elige el curso y el canal, pulsa los botones o las filas de una lista, o escribe como si fueras la persona. Los archivos aparecen con su nombre y una plantilla de WhatsApp con datos de ejemplo. **No se envía nada a nadie ni se guarda nada.** Se prueba lo que ves en pantalla, aunque no lo hayas guardado.

## 5. Publicar y activar

1. **Publicar** guarda lo que hay (si falta), lo revisa y te pide confirmar. Si quedan **avisos** (una salida sin conectar, un paso al que no llega nadie…), la ventana los nombra uno por uno, con su paso y **Ir al paso**, y el botón dice **Publicar de todos modos**: los avisos no impiden publicar, pero ya no se publica sin verlos. Lo publicado queda como una **versión** (1, 2, 3…), que ves en la pestaña **Versiones**.
2. Las conversaciones que ya iban en el recorrido **siguen con la versión con la que empezaron**; las nuevas usan la recién publicada.
3. **Activar** hace que empiece a atender, siempre que la automatización de la marca esté encendida y su asistente responda solo. **Pausar** deja de empezar con gente nueva (y, si lo eliges, detiene las conversaciones en curso). **Archivar** lo retira; su historial se conserva.

### Si lo activaste y no contesta

Un recorrido activo sólo atiende si **la marca está atendiendo con recorridos**. Si no, la lista y el recorrido lo dicen con un aviso amarillo, el estado aparece como «Activo, pero la marca no está atendiendo» y la ventana de «Activar» te lo advierte antes de confirmar. Mientras tanto contesta el asistente de siempre. Hay tres motivos, y los tres se arreglan en **Operación → Ventas y cobro → Seguimientos**:

- **La automatización de la marca está apagada:** en la sección «Automatización», pulsa «Activar» en la marca.
- **La automatización está en pausa para todas las marcas:** en esa misma sección, quita la pausa global.
- **El asistente no responde solo:** en «Respuestas automáticas a clientes», cambia el «Nivel de respuestas» de la marca a «Responder con plantillas» o «Autónomo con IA» («Apagado» y «Sugerir al asesor» no contestan solos).

Si además ves «El modo real de esta marca está apagado», es sólo información: los recorridos atienden igual, también por WhatsApp real, pero sus mensajes llevan los avisos de prueba («Chat de prueba…», «Pago de prueba…»). Para atender clientes de verdad sin esos avisos, enciende el modo real de la marca en Operación → Ventas y cobro → Pagos ([PLAN_MODO_REAL.md](PLAN_MODO_REAL.md)).

### Si la persona escribe otra vez la palabra clave

Cuando un recorrido que empieza con una palabra clave está esperando una respuesta (unos botones, una lista, una pregunta) y la persona escribe de nuevo la palabra —o toca otra vez el anuncio, que manda su frase—, el recorrido **empieza de nuevo** desde el saludo. La atención anterior se cierra como «empezó de nuevo» y no cuenta como terminada ni como abandonada en el rendimiento. Sólo aplica a los recorridos que se pueden repetir «siempre»: con «una vez por conversación» o con un descanso entre repeticiones, la palabra se toma como una respuesta que no se entendió y contesta el asistente. La ventana **Probar** hace lo mismo y lo anota («el recorrido empieza de nuevo»).

## 6. Leer su rendimiento

En la pestaña **Rendimiento**, elige el periodo (7, 30 o 90 días) y la versión:

- **Empezaron, terminaron, pasaron con una persona, se fueron y en curso.**
- **Dónde se pierde gente**, lo más débil primero: «El 62 % se va en el paso 4, “¿Te gustaría inscribirte?”». Con **Ver en el recorrido** las cifras aparecen sobre cada paso, en Pasos y en el lienzo.
- **Paso por paso**: cuántas conversaciones llegaron, cuántas siguieron, cuántas se fueron ahí y cuánto tardan en contestar (la mediana).
- **Cómo terminaron**: terminó el recorrido, pasó con una persona, una persona tomó el chat, dejó de contestar, escribió otra cosa, error.

Las cifras son conteos: no muestran nombres, teléfonos ni lo que escribió nadie.

## 7. Sugerencias

En Rendimiento, **Pedir sugerencias** revisa el recorrido y sus cifras y propone mejoras ligadas a un paso: mensajes demasiado largos, preguntas sin salida, pasos donde se va la gente, falta de «pasar con una persona», tono. Hay dos fuentes: la **revisión automática** (siempre) y la **IA** (si está configurada y no se alcanzó el tope mensual de la IA; si no, lo dice). A la IA sólo se le manda la estructura del recorrido y las cifras por paso, **nunca** datos de personas ni conversaciones. Las sugerencias **no cambian nada**: tú decides qué aplicar.

## 8. ¿Regla o recorrido?

Para algo de un solo paso no hace falta dibujar un recorrido: basta una **regla** (menú WhatsApp → **Reglas**, en vista previa). Una regla dice «cuando un mensaje tiene esta palabra (y, si quieres, sólo en este canal, curso, horario, con esta etiqueta o en el primer mensaje), haz esto»: responder un texto, mandar un material aprobado, iniciar un recorrido, poner o quitar una etiqueta, pasar con una persona o cambiar el estado de la conversación.

| Usa una regla cuando… | Usa un recorrido cuando… |
| --- | --- |
| La respuesta es una sola: «¿precio?» → el precio vigente; «¿temario?» → el material del temario. | Hay varios pasos: saludar, mandar la ficha, esperar, preguntar con botones, pedir el correo. |
| Quieres etiquetar o pasar con una persona a quien escribe ciertas palabras («queja», «factura»). | Necesitas guardar lo que la persona contesta y decidir según su respuesta. |
| Quieres decidir **cuál** recorrido empieza según lo que escribe la persona. | La conversación debe seguir aunque la persona tarde en contestar. |

**Quién contesta primero.** La pantalla de Reglas muestra el **orden de atención** con el estado real de la marca: (1) una persona del equipo que tomó el chat, (2) un recorrido en curso, (3) las reglas, en el orden de su lista (la primera que coincide y responde gana; las etiquetas de las demás también se ponen), (4) un recorrido que arranca y (5) el asistente de la marca. Las reglas atienden con las mismas condiciones que los recorridos: la automatización de la marca encendida y su asistente respondiendo solo.

**Probar.** «Probar con un mensaje» dice quién contestaría y qué haría cada regla, sin enviar ni guardar nada. Una regla nueva nace en **borrador**; enciéndela cuando esté lista. Detalle técnico: [PLAN_REGLAS.md](PLAN_REGLAS.md).

Detalle técnico: [PLAN_RECORRIDOS.md](PLAN_RECORRIDOS.md).
