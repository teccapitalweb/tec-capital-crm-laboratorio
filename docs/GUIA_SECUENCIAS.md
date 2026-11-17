# Guía: secuencias de seguimiento

Una **secuencia** manda mensajes solos en los días siguientes a que alguien pide información de un curso, hasta que se inscribe, dice que no o alguien del equipo toma la conversación. Sustituye las difusiones que se mandaban a mano («estamos cerrando inscripciones», «hoy empezamos», «precio especial de hoy»).

Detalle técnico: [PLAN_SECUENCIAS.md](PLAN_SECUENCIAS.md).

## Antes de empezar

- La pantalla está en **WhatsApp → Secuencias**. Administración crea y edita; el resto del equipo ve las secuencias, su vista previa y sus resultados.
- Para que una secuencia envíe algo deben estar encendidas **tres cosas**: la automatización de la marca, el asistente en «Plantillas» o «Autónomo», y la propia secuencia. Toda secuencia nueva nace **apagada**.
- Fuera de las 24 horas desde el último mensaje de la persona, WhatsApp sólo deja enviar **plantillas aprobadas**. Por eso los pasos de varios días después suelen ser plantillas.
- Las fechas del curso salen del **catálogo** (la edición). Si la edición no tiene fecha de inicio, los pasos «antes del inicio» se omiten.

## Ejemplo paso a paso

Curso de aves que empieza el sábado 21 a las 18:00. Queremos escribir al día siguiente, a los tres días, dos días antes del inicio y el mismo día.

1. **Nueva secuencia** → Nombre: «Seguimiento aves». Curso: «Plan sanitario para aves». Quién entra: «Recibió la ficha del curso».
2. **Paso 1** — Cuándo: «Después de inscribirse en la secuencia», Esperar `1` `días`. Qué envía: plantilla «seguimiento_dia_1» (por ejemplo «¿Pudiste revisar la ficha? ¿Te ayudo con tu inscripción?», con los botones «Sí, deseo inscribirme» / «No, por el momento»).
3. **Agregar paso** → Paso 2 — Esperar `3` `días`. Plantilla «cerramos_inscripciones».
4. **Agregar paso** → Paso 3 — Cuándo: «Antes del inicio del curso», Días antes `2`, Hora `10:00`. Plantilla «faltan_dos_dias».
5. **Agregar paso** → Paso 4 — Antes del inicio, Días antes `0`, Hora `09:00`. Plantilla «hoy_empezamos».
6. Deja «Si la persona responde: Pausar» y «Si alguien del equipo toma el chat: Pausar». Revisa las frases de alto (ya trae «no, por el momento») y las de sí («sí, deseo inscribirme»).
   Horario de envío: «De día». Importa aquí porque el curso empieza en **sábado**: con «En el horario de atención de la marca» y un horario de lunes a viernes, el mensaje del sábado esperaría al lunes y, como el curso ya habría empezado, se omitiría.
7. **Guardar** → **Vista previa** (no envía nada: dice quién entraría y quién recibiría su paso ahora) → **Encender**.

Si alguien recibe la ficha el lunes 16 a las 10:00, recibe el paso 1 el martes 17 a las 10:00, los pasos 2 y 3 el jueves 19 a las 10:00 (dos mensajes ese día: justo el tope diario) y el paso 4 el sábado 21 a las 9:00. Si se inscribe y paga el miércoles, no recibe nada más.

Puedes usar un **texto** en lugar de plantilla (sólo sale con la ventana abierta) y elegir qué pasa si está cerrada: enviar una plantilla de respaldo, omitir el paso o detener la secuencia.

## Cuándo se detiene sola

Se inscribe o paga el curso · dice que no («no, por el momento») · pide la baja · está en una lista de exclusión · responde (pausa o alto, según elegiste) · alguien del equipo toma el chat (pausa o alto) · la conversación se cierra o se bloquea · el número está en modo escucha · se apaga la automatización de la marca o la secuencia · el curso ya empezó o terminó · terminó sus pasos.

Una pausa se reanuda sola cuando la conversación vuelve al asistente y la persona lleva las horas que elegiste sin escribir (24 por omisión).

## Protecciones que no tienes que configurar

- Nadie recibe más de **2 mensajes automáticos al día** sumando secuencias y difusiones de la marca.
- No se escribe fuera del horario de atención de la marca (o, si eliges «De día», en el horario de silencio de las difusiones).
- Cada secuencia tiene un **tope de mensajes al mes** (500 por omisión).
- Las plantillas promocionales sólo van a quien aceptó recibir mensajes (puedes desmarcarlo).

## Resultados

En **Resultados** verás cuántas personas entraron, cuántos mensajes salieron por paso, quién respondió, quién dijo sí o no, por qué se detuvieron y cuántas **se inscribieron en los 7 días siguientes a cada paso** (lo puedes cambiar). Úsalo para quitar el paso que no ayuda o cambiar su plantilla.
