# Un número de WhatsApp para toda la consultora (13 nov 2026)

Publicado en `main` (13 nov 2026). **Esquema 41.** Apagado por omisión: cada número sigue recibiendo en su curso de siempre hasta que administración lo cambie.

## Para qué

Hasta ahora un número real de WhatsApp recibía a todos en **un** curso. El usuario pidió que el número sea la consultora completa: que el curso lo decida el anuncio de Instagram o Facebook por el que llegó la persona, y que el asistente conteste de todos los cursos de la marca.

## Cómo se decide el curso

En **Conectores → WhatsApp real · Meta → Editar número → «Qué cursos atiende: Todos los cursos de la marca»**. Con eso encendido:

1. **Por el anuncio.** Cuando alguien toca un anuncio que abre WhatsApp, Meta manda el identificador del anuncio, su título y su texto. El CRM anota cada anuncio por marca (`wa_ads`) y usa, en este orden: el curso que administración le asignó en Conectores → «Anuncios por los que han llegado personas»; si no tiene, el curso que se reconoce en el título y el texto del anuncio.
2. **Por lo que escribe.** «Hola, me interesa el curso de aves» se reconoce por las palabras propias de ese curso dentro de la marca (sirve también para enlaces y códigos QR con mensaje ya escrito).
3. **Si no se sabe, se pregunta.** La conversación queda con el curso **por elegir** (`conversations.course_pending`) y el asistente manda la lista numerada de cursos de la marca. No habla de precios ni fechas hasta que la persona elige, por número o por nombre. Dos intentos sin reconocer y a la tercera pasa a una persona.

Una marca con un solo curso disponible nunca pregunta.

## Cambiar de curso en el mismo chat

- «¿Y el de aves cuánto cuesta?» contesta de aves y la conversación **pasa a aves**. A media conversación hace falta una señal además de la palabra («el de…», «curso», «también», «mejor») o dos palabras propias del curso: «tengo 200 aves, ¿me sirve?» no cambia nada.
- «¿Qué otros cursos tienen?» da la lista numerada; el número siguiente elige. Un número suelto sin lista antes no elige nada.
- Si la persona vuelve a entrar por el anuncio de otro curso, su conversación pasa a ese curso.
- **Con un pedido vigente no se cambia solo**: el asistente le dice que escriba «asesor».

## Qué pasa en el CRM al cambiar

`crm.moveConversation()`: la conversación cambia de curso y edición, y se liga al interés (oportunidad) del curso nuevo. El interés anterior **se conserva** (la persona sí preguntó por ese curso). Excepción: si el curso anterior era sólo el de relleno mientras no elegía y su interés seguía en «nuevo», ese mismo interés pasa a ser el del curso elegido, para no dejar un seguimiento de un curso que nunca pidió. Nunca se mueve a un curso de otra marca ni se choca con otra conversación abierta de la misma persona en ese curso.

Los mensajes anteriores conservan su ficha y su precio tal como salieron.

## Ajustes con el catálogo real de GlobalVet (13 nov 2026, rama `feat/catalogo-real-ajustes`, sin publicar)

Con los 18 cursos de noviembre cargados en un servidor local salieron cuatro cosas:

- **Cursos con nombres parecidos.** «El de reptiles» (dos cursos), «el de bovinos» (tres), «el de perros y gatos»: en lugar de repetir la lista completa, el asistente ofrece **sólo esos** («Tenemos 2 cursos de ese tema. ¿Cuál te interesa?»). `candidates()`; «bovino», «bovinos» y «bovinas» cuentan como la misma palabra.
- **El número elige de la lista que se mostró.** Se lee del propio mensaje del asistente (lista completa o corta), así no depende del orden del catálogo.
- **Fecha sin hora.** Una edición con día pero sin hora (medianoche en su zona) se muestra «martes, 17 de noviembre de 2026», sin «12:00 a.m.».
- **«¿Quién lo imparte?»** ya se entiende como pregunta de fechas y docente.
- **«Hola, quiero el curso de aves»** como primer mensaje elige el curso y recibe la ficha; ya no arma un pedido de inmediato (con «inscribirme» sí).

## Lo que ve el equipo

- En el chat, mientras no elige: **«Curso por elegir · el asistente se lo está preguntando»** en lugar del curso.
- En la bitácora de respuestas: «Eligió el curso «…»» o «Cambió al curso «…»».
- En Conectores: cada anuncio con su título, su identificador, cuántas personas han llegado por él y el curso asignado.

## Datos (esquema 41)

- `wa_numbers.multi` (0 por omisión).
- `conversations.course_pending` (0 por omisión).
- `wa_ads(brand_id, ad_id, headline, body, course_id, hits, revision, updated_by, first_seen, last_seen)`.

Migrar no cambia ningún dato existente. Copia previa: `backups/before-crm-v41-*`.

## Dónde está

- `server/course-match.mjs`: `brandCourses`, `matchCourse`, `byNumber`.
- `server/whatsapp.mjs`: `adOf`, `adCourse`, alta de la conversación con curso por elegir, `saveAd`, `PUT /api/whatsapp/ads`.
- `server/crm.mjs`: `moveConversation`.
- `server/replies.mjs`: `route`, intención `choose_course`, `out.move`.
- `server/reply-copy.mjs`: `chooseCourse`, `courseMenu`, `switchBlocked`.
- `public/connectors.js`: opción del número y lista de anuncios.

## Verificación

- `test/whatsapp-multi.test.mjs` (2 pruebas, con Meta y Anthropic de mentira): reconocimiento del curso; y de punta a punta: apagado por omisión, lista de cursos sólo de la marca, sin precios hasta elegir, elegir por número o por nombre, cambio de curso con señal, palabra suelta que no cambia, número suelto que no elige, pedido vigente que lo impide, pago reportado que sigue pasando a una persona, anuncio con curso reconocible, anuncio ligado por administración (marca ajena 400, revisión vieja 409), paso por anuncio de quien no había elegido, tres intentos y pase a una persona, interés anterior real que no se toca, la IA recibe el curso elegido, y laboratorio y números de un solo curso sin cambios.
- Suite completa: **215 pruebas**. `npm run check` limpio.
- Revisión independiente: cuatro hallazgos corregidos con su prueba (tras elegir o cambiar de curso la IA recibía los datos del curso anterior; el interés de relleno podía ser un interés real anterior de la persona; «ya pagué, el de aves» con pedido vigente no pasaba a una persona; un cambio que ya no se podía hacer dejaba a la persona sin respuesta). Además: un número sólo elige si el último mensaje era una lista, tope de 500 anuncios anotados por marca, y la memoria del cliente no manda a la IA el curso de relleno.
- En el navegador, demo local con Meta simulado: Conectores (opción del número, lista de anuncios, asignar curso) en computadora y a 375 px sin desborde; en el chat, «Curso por elegir».

## Límites

- **Sin probar contra Meta de verdad.** El número de prueba de Meta no puede correr anuncios: la llegada por anuncio se verificó con un Meta simulado. El reconocimiento por texto y la lista sí se pueden probar desde un teléfono.
- El reconocimiento es por palabras del **título** del curso. Dos cursos con títulos casi iguales no se distinguen por una palabra compartida: se pregunta. No hay sobrenombres por curso todavía.
- La lista de cursos va como texto numerado (los botones de WhatsApp admiten 3 opciones de 20 letras; los títulos no caben).
- Sólo WhatsApp real. Los perfiles del laboratorio siguen eligiendo curso al crear la conversación.
- El flujo de bienvenida de la marca no se muestra mientras el curso está por elegir.
- Un material programado (temario, precio) se arma al enviarse con el curso que tenga la conversación en ese momento: si cambió de curso, sale el del curso nuevo.
- Si el catálogo cambia entre que se muestra la lista y la persona responde con un número, el número puede apuntar a otro curso.
- Mientras el curso está por elegir, la conversación guarda por dentro el curso por omisión del número: Cobrar o enviar un flyer desde el equipo usarían ese curso.
- Pauta sigue contando por edición: una conversación que cambia de curso cuenta en el curso donde quedó.
