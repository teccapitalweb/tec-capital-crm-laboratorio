# Respuestas de venta: pagos, constancia, posventa y menos IA (21 nov 2026)

Publicado en `main` el 21 nov 2026 (commit `54556b6`). Una migración con nombre: `replies/0001-certificate-name-requests` (tablas `certificate_name_requests` y `certificate_name_events`; esquema `41+32.c05a5695`). Las dos migraciones anteriores de esta rama nunca llegaron a `main` y se fundieron en ésta.

## Por qué

El dueño pidió respuestas «más pro», enfocadas a vender, y gastar menos en IA. Se midió el motor de tres pisos (reglas → conocimiento aprobado → Claude) con dos fuentes que se quedan fuera de Git:

- un análisis de **7,117 conversaciones** reales de una consultora de cursos (sólo conteos por intención: **19,981 mensajes** de clientes), y
- un **banco de 173 frases y 12 conversaciones** escritas a mano con esas proporciones, pasado por el simulador del motor en una base local de usar y tirar, con el catálogo de 17 cursos de prueba y dos versiones de conocimiento: **A** = las 6 respuestas de ejemplo que trae una marca nueva, **B** = A más el CSV de ejemplo del repositorio (10 aprobadas). Sin IA real (proveedor simulado: se sabe si se le habría llamado, no qué habría dicho).

Lo que salió: el motor contestaba muy bien lo que más llega (la frase del anuncio, «información», «Sí, deseo inscribirme», «gracias»), pero **de las preguntas sólo 3 de cada 10 salían bien, 1 de cada 3 iba a la IA y 1 de cada 4 recibía una respuesta equivocada sin costo**, sobre todo en pagos y en lo que pasa después de pagar.

## Qué cambió

| # | Hueco medido | Qué hace ahora | Dónde |
| --- | --- | --- | --- |
| 1 | Todo lo que sonaba a pago recibía «Puedes pagar con…» | El pago se parte: **cómo pago** (igual que antes), **ya pagué** (gana siempre a la inscripción; acuse con el estado real del pedido y pasa a una persona), **pago después** (acuse sin presionar y la vigencia de su pedido; «el lugar queda asegurado cuando se confirma el pago»), **¿ya verificaron?** (el estado real; «activa» sólo si la inscripción lo está), **último día para pagar** (la vigencia de su pedido), **factura**, **meses o en partes**, **varias personas** y **datos de la cuenta** (sólo con una respuesta aprobada que de verdad hable de eso; si no, pasa a una persona). Nunca confirma un pago. | `server/lib/sales-replies.mjs` (`paymentKind`), `server/replies.mjs`, textos en `server/reply-copy.mjs` |
| 2 | «Mi nombre para la constancia es…» recibía el texto del certificado o **creaba un pedido** | Los datos (nombre completo, correo, teléfono) se acusan sin crear pedido y se guardan como **propuesta ligada al pedido** (`certificate_name_requests`). Un nombre sólo con señal explícita; nunca de un saludo, agradecimiento, queja o frase de pago. El certificado sale con ese nombre **sólo si alguien del equipo lo confirma** en la ficha de la apertura (Coordinación → Certificados: «Usar este nombre» o «Corregir nombre»), salvo que sea el mismo nombre de la persona. La franja de la venta en el chat también lo muestra. | migración `replies/0001`, `server/replies.mjs`, `server/certificates.mjs`, `public/certificates.js`, `public/sale.js` |
| 3 | «Sí, me interesa» (botón de una plantilla de seguimiento) **reenviaba la ficha** | Fuera de la pregunta de la ficha sigue el camino de la inscripción. Ya inscrita, no se intenta otro pedido: «tu inscripción ya está activa». | `server/replies.mjs` |
| 4 | Frases claras que iban a la IA o a la ficha equivocada | Reglas sin gasto: «buen día»; inscripción como sustantivo o decisión (sin «¿qué incluye la inscripción?», «lo tomo en cuenta» ni «¿cuánto cuesta la inscripción?»); plazo para inscribirse sin crear pedido; «número de cuenta»; «me **puede** llamar»; **validez oficial, SEP, cédula, valor curricular**: sólo lo que consta y nunca «Sí»; cupo con el tamaño del grupo (y «¿hay espacio para estacionarse?» no es cupo); duración con las fechas de la apertura; «¿hay repetición?» es grabación; «¿ya empezó?» son fechas; hasta cuándo la promoción. | `PATTERNS` en `server/replies.mjs` |
| 5 | Con 6 respuestas aprobadas o menos, **todo** el conocimiento iba a la IA ante cualquier mensaje sin intención | `rankKnowledge` exige parecido también con pocas entradas. Si nada se parece: un mensaje corto que no pregunta no va a la IA; una **pregunta real** sí, con el conocimiento chico completo (el validador exige que la IA cite una respuesta aprobada; sin ninguna, el borrador se descartaría y la llamada se pagaría para nada). | `server/retrieval.mjs`, `server/replies.mjs` |
| 6 | «¿Cuál me recomiendas?», «¿tienen algo de reptiles?» iban a la IA | Recomendación **sólo con el catálogo de la marca** (títulos y temarios, palabras completas; una palabra común a muchos títulos no cuenta; por el temario hacen falta dos coincidencias): hasta 5 cursos con su inicio y precio vigentes. Sin tema, «¿Qué tema te interesa?»; con un tema que no aparece, lo dice y ofrece los que hay. «¿Este curso me sirve?» nombrando algo que el curso no cubre no recibe requisitos. | `recommend`, `notCovered` en `server/lib/sales-replies.mjs` |
| 7 | «¿Dónde entro?», «no me llegó el enlace» iban a la IA | Sólo con inscripción activa o pedido pagado o en revisión existe la posventa. Se **reenvía** lo mismo que ya recibió (misma revisión del texto, entrega encendida), con tope de 2 reenvíos del asistente por inscripción y día, cada uno auditado. Si no, o si algo «no abre», pasa a una persona diciendo qué pasa. | `server/modules/course-access/module.mjs` (`replies.useAccess`) |
| 8 | Después de pasar a una persona, **nada** recibía respuesta | **Una sola respuesta automática por espera**: el acuse («Ya le avisé al equipo…») o, si lo primero fueron sus datos para la constancia, el acuse de los datos. Lo que llega después se guarda sin contestar. Un mensaje que pide algo (que le llamen, un asesor) nunca recibe «anoté…». No aplica si alguien del equipo la tomó o ya escribió, en «Apagado» o «Sugerir», ni a un archivo. | `server/operations.mjs` (`useCustomerWaiting`), `ackWhileWaiting` en `server/replies.mjs` |
| 9 | Pequeñas | Objeción de tiempo; otra fecha y «avísame de la siguiente»; descuento sin promoción vigente (sin sugerir precio especial); varias personas (también «mi hermana también quiere inscribirse») con una persona; quien busca trabajo; «gracias» de quien ya pagó; «¿manejan diplomados?»; «ahorita no, más adelante». Si armar la respuesta o crear el pedido falla, la persona recibe que una persona la atiende y la conversación pasa al equipo (nunca se queda sin respuesta). | `server/replies.mjs`, `server/reply-copy.mjs` |

Dos intenciones nuevas en la bitácora (`reply_log`): `access` y `cert_data`, con su etiqueta en Conocimiento, Evaluación y Presentación.

## Revisión independiente

Una revisión independiente del primer commit encontró 4 fallos altos, 5 medios y 4 bajos (reproducidos contra un servidor local). Todos se corrigieron, cada uno con su prueba en `test/sales-replies.test.mjs` (o la indicada) usando la frase exacta del hallazgo:

1. **Nombre del certificado sustituido por basura** («HOLA BUENAS TARDES», «MUCHAS GRACIAS», «LO VEO CON MI ESPOSO», «NADIE ME CONTESTA», «el deposito lo hice a nombre de Juan Perez Lopez»): sin la regla de «todo en mayúsculas»; sólo señal explícita; una señal débil no pisa un nombre; un nombre explícito nuevo se acusa con «Cambié el nombre de … a …»; el nombre es una propuesta que confirma el equipo; tabla por pedido con `contact_id`, registrada en `server/lib/person-data.mjs` con fusión, exportación y borrado (`test/person-data.test.mjs`).
2. **«Ya realicé el pago de mi inscripción» se leía como inscripción**: «ya pagué» gana; «incluye» y «en cuenta» no son inscripción; ya inscrita no se intenta otro pedido; un pedido que no se puede crear pasa a una persona en lugar de fallar el trabajo.
3. **Posventa con preguntas de prospectos** («¿me pasas el link para pagar?», «¿me mandan información del curso?», «el curso ya empezó?»…): `access` sólo con inscripción o pedido pagado o en revisión, y sin «curso», «material», pago, temario, información ni datos.
4. **Reenvío de accesos sin control**: respeta el interruptor, sólo la misma revisión ya entregada, tope 2 por inscripción y día, auditado.
5. **Acuse «único» que no lo era con datos**: una sola respuesta automática por espera; «mi numero es 5512345678 llamenme» no recibe «anoté».
6. **Especie o tema que el curso no cubre** («Soy Ana y trabajo con ganado, ¿este curso aplica para bovinos también?», «tengo una granja de cerdos, ¿me sirve este curso?»): ni requisitos ni recomendación por una sola palabra del temario.
7. **«Tu inscripción está activa» con la inscripción dada de baja**: se comprueba `enrollments.status`.
8. **Preguntas reales sin IA con 6 respuestas o menos**: vuelven a la IA (ver punto 5 de la tabla). Las pruebas `assistant-flow`, `mcp-recorridos` y `replies-learn` volvieron a sus frases originales y pasan.
9. `certificate_details` fuera del registro de datos de persona: sustituida por `certificate_name_requests`, registrada.
10. **Vocabulario de un ramo en el código** (familias de especies, «¿con qué especie trabajas?», «soy auxiliar» → urgencias): fuera; la coincidencia sale sólo del catálogo de la marca.
11. «¿hasta cuándo es la promoción?» y «¿cuál es el último día para pagar?» contestan con la promoción y el pedido reales.
12. «¿hay espacio para estacionarse?» no es cupo; «mi hermana también quiere inscribirse» es varias personas; sin «precio especial por ser estudiante» ni «hasta que empiece el curso».
13. El perfil «Sensible al precio» del simulador vuelve a preguntar por meses sin intereses; sin respuesta aprobada, su conversación queda con una persona (`test/simulator.test.mjs`).

Además: la prueba intermitente de `test/mcp-cursos-borrador.test.mjs` acepta las dos respuestas correctas de la carrera entre el reloj de mantenimiento y la aprobación (`stale_proposal`, o `already_decided` con estado `stale`). Y se pasaron 58 frases vecinas nuevas (prospecto, cliente que ya pagó, quien espera a una persona) por el motor; lo que salió mal se corrigió («ya les mandé la captura», «me registré pero no me llegó nada», «¿dónde se toma la clase?», «¿me pasan los datos del curso?», «busco algo de citología») y lo más representativo quedó en las pruebas.

## Segunda revisión independiente

Una segunda revisión de las correcciones dejó 1 hallazgo alto, 6 medios y 6 bajos, casi todos reproducidos con el motor. Corregidos, cada uno con su frase exacta y su caso negativo en `test/sales-replies.test.mjs` (salvo donde se indica):

- **A1** «Tu inscripción ya está activa» sólo con una inscripción viva (`enrollments.status='enrolled'`) del curso de la conversación; las consultas de pedido e inscripción miran el curso. Oportunidad «ganada» sin inscripción viva, o una baja: pasa a una persona con un texto neutro. «Otro curso» y varias personas se miran antes; una petición de inscripción ya no trae accesos.
- **M1** Con pregunta, «si lo tomo», «ya quedó», «en línea» o constancia no es inscripción; «¿Ya quedó mi inscripción?» es el estado de su pedido.
- **M2** Una negación delante del verbo («todavía no pagué», «aún no deposité», «nunca me llegó») no es «ya pagué»; «nunca me llegó el comprobante» pasa a una persona sin decir que se revisa un pago; «no me llegó el enlace de pago» reenvía el de su pedido.
- **M3** «¿aún hay vacantes?» es cupo; empleo sólo con frases de empleo.
- **M4** Datos de otra persona, datos para la factura, «para inscribirme» o una petición de información no son datos de la constancia; sin pedido no se piden.
- **M5** Tope de reenvíos y texto de accesos cambiado tienen su propio texto.
- **M6** Sin ajustes de certificados de la marca no se afirma emisor ni formato.
- **B1** Confirmar el nombre: control de concurrencia (409 si la persona pidió otro), rechaza inscripciones dadas de baja o ya certificadas, limpia el nombre, guarda nombre anterior y nuevo en `certificate_name_events`; «hoy saldría como…» se calcula igual que al emitir. Pruebas de autorización (otra marca, agente que no es responsable, nombre corto). La pantalla usa la ventana propia de la app en lugar de `window.prompt`.
- **B2** El registro de datos de persona dice tal cual que exportación y borrado todavía no tienen quien los llame (`server/lib/person-data.mjs`, `test/person-data.test.mjs`).
- **B3** «q días…», descuento de contado, enlace de pago que no abre, precio y meses juntos, «cuánto sería por los dos», descuento a quien ya pagó, «¿cómo entro a la clase?» con pedido pendiente; y con cupones que el cliente puede escribir no se niega el descuento.
- **B4** Un nombre confirmado por el equipo no se borra cuando llega otro: el nuevo queda como solicitud pendiente y visible.
- **B5** Una sola migración (ver arriba); la prueba parte de una base sin el área `replies`, como `main`.
- **B6** Ventana de 24 horas del tope con el reloj inyectado (`assistantResends`), sin borrar entregas.
- La prueba intermitente de `test/mcp-cursos-borrador.test.mjs` acepta las dos respuestas de la carrera.

Además se pasaron 45 frases vecinas nuevas (prospecto, pedido pendiente, inscripción activa, en espera) y las sondas del revisor; lo que salió mal se corrigió y quedó en las pruebas.

La medición del banco de abajo es la de la primera revisión; tras la segunda no se volvió a medir.

## Medición antes y después

Mismo banco y misma herramienta antes (commit base `7e8e9db`) y después (este trabajo, tras la revisión), en local, sin IA real. «IA» = el motor habría llamado a Claude. Calidad: una respuesta que no cambió conserva su calificación original; las que cambiaron **las califiqué yo mismo, que hice los cambios** (hay sesgo): *buena* contesta lo que se preguntó, *parcial* algo relacionado, *persona* pasa a una persona, *genérica* «no la tengo a la mano» sin gasto, *mala* contesta otra cosa, *riesgosa* afirma algo que no consta.

**Por frase (173):**

| | Buena | Parcial | Persona | IA | Genérica | Mala | Riesgosa |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A antes | 73 | 25 | 5 | **50** | 0 | 19 | 1 |
| A después | 117 | 16 | 19 | **20** | 0 | 1 | 0 |
| B antes | 77 | 25 | 5 | **32** | 14 | 19 | 1 |
| B después | 119 | 16 | 19 | **14** | 4 | 1 | 0 |

**Ponderado por lo que se pregunta de verdad:**

| | Buena | Parcial | Persona | IA | Genérica | Mala | Riesgosa |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Todo el tráfico, A antes | 66.4 % | 13.9 % | 1.0 % | 11.2 % | 0 % | 7.3 % | 0.2 % |
| Todo el tráfico, A después | 88.9 % | 4.8 % | 3.0 % | 3.0 % | 0 % | 0.3 % | 0 % |
| Sólo preguntas, A antes | 28.8 % | 11.1 % | 3.2 % | 32.2 % | 0 % | 23.9 % | 0.8 % |
| Sólo preguntas, A después | 72.3 % | 7.1 % | 9.8 % | 9.8 % | 0 % | 1.0 % | 0 % |
| Sólo preguntas, B antes | 30.5 % | 11.1 % | 3.2 % | 17.3 % | 13.2 % | 23.9 % | 0.8 % |
| Sólo preguntas, B después | 73.0 % | 7.1 % | 9.8 % | 7.9 % | 1.3 % | 1.0 % | 0 % |

**IA y tokens de contexto aproximados** (entradas de conocimiento enviadas × tamaño medio de una entrada, ÷ 4 caracteres por token; sin el prompt fijo ni la respuesta):

| | Llamadas | Entradas enviadas | Tokens de contexto aprox. |
| --- | ---: | ---: | ---: |
| A antes | 50 | 300 | 18,250 |
| A después | 20 | 67 | 4,076 |
| B antes | 32 | 64 | 4,367 |
| B después | 14 | 28 | 1,910 |

Las llamadas que quedan son preguntas reales sin regla ni respuesta aprobada: en el simulador las de acceso no tienen inscripción (así que se leen como preguntas normales), y las de nivel, confianza, otro país y cambio de curso. La mala que queda («después del pago, ¿cómo ingreso a las clases?» → formas de pago) no cambió: en el simulador no hay inscripción y la frase menciona el pago.

Más «persona» es a propósito: factura, meses, varias personas, datos de la cuenta y «avísame de la siguiente» ya no reciben un texto equivocado.

**Las 12 conversaciones:** «Sí, me interesa» a media conversación crea el pedido; «en la quincena pago» y «ahorita le mando el pago» reciben la vigencia de su pedido sin crear otro; tras un pase, una sola respuesta automática por espera (los datos para la constancia se guardan sin contestar más); la objeción de tiempo y «avísame cuando lo vuelvan a abrir» tienen su respuesta. Sigue igual: «mejor el de geriatría» no cambia de curso.

Cautela: el banco se redactó a mano con proporciones de otro ramo y nada se probó con IA real.

## Reglas que se respetan

- Precio, fechas, cupo y promoción salen del catálogo vigente; quién emite el certificado, de Certificados; la vigencia del pedido, del pedido. Ningún texto nuevo lleva una cifra escrita a mano.
- El asistente **nunca confirma un pago** ni decide el nombre de un certificado: los dos los confirma una persona.
- Lo que el catálogo o la configuración no saben se contesta con una respuesta aprobada que lo diga o lo atiende una persona.
- Todo por marca; ningún vocabulario de un ramo en el código.

## Pruebas

- `test/sales-replies.test.mjs`: la lectura fina con sus vecinos; las migraciones sobre una base ya publicada (`assertSchemaCurrent`); y de punta a punta cada punto de la revisión con su frase exacta.
- `test/person-data.test.mjs`: la tabla nueva en el candado, en la fusión y con exportación y borrado.
- `test/real-mode.test.mjs`: cada texto nuevo de `reply-copy.mjs` comprobado en modo real.
- `test/simulator.test.mjs`: «Sensible al precio» deja su conversación con una persona.
- `test/replies-resume.test.mjs`: tras pedir una persona, un acuse, una sola vez. `test/replies-intents.test.mjs`: «certificado oficial» en varias preguntas ya no recibe «Sí».
- `server/summaries.mjs` no cuenta el acuse como respuesta.

## Después de la primera prueba con conocimiento real (21 nov 2026)

Con 30 respuestas de GlobalVet aprobadas, en WhatsApp real salieron dos cosas, corregidas en `server/lib/sales-replies.mjs` y `server/replies.mjs` con su prueba en `test/sales-replies.test.mjs`:

- **«¿Cuánto dura cada clase?»** recibía sólo las fechas del catálogo: la intención `duration` contestaba con el calendario antes de mirar el conocimiento. Ahora, si una respuesta aprobada de duración se parece mucho a la pregunta, lo que añade (`durationFacts`: «cada sesión dura alrededor de dos horas») va primero y el calendario de la apertura debajo; sus frases que remiten a la ficha, la edición o el calendario sobran, porque la ficha va debajo (la respuesta de ejemplo «dime qué edición» no añade nada). Entre varias respuestas de duración gana la más específica (`pickSpecific`: la que más de sus propias palabras tiene en la pregunta; para el motor «curso» es una palabra comodín, así que «¿cuánto dura el curso?» y «¿cuánto dura cada clase?» se parecen igual a las dos), y en empate la más antigua de la marca.
- **«¿Puedo pagar por OXXO o algo así?»** recibía «¿dónde deposito?»: cuando ninguna respuesta de pago se parecía lo bastante, el motor tomaba «la primera del tema», que es la última tocada (la lista va por fecha de cambio). Ahora (`pickByTopic`) gana la que comparte alguna palabra con contenido y, si ninguna, la más antigua del tema. Vale para todos los temas reconocidos (pago, certificado, requisitos, modalidad, grabación, duración).

- **La ficha de cada curso cuenta para recomendar.** El conocimiento aprobado ligado a un curso (`course_id`) es su ficha: sus variantes son palabras parecidas («vacas», «reses», «rancho», «cachorros», «iguanas») y valen como el título, así que una sola basta para recomendarlo; su pregunta y respuesta cuentan como parte del temario (`courseNotes` en `server/replies.mjs`, `aliases` en `recommend` y `notCovered`). Lo que muchas fichas comparten («¿para quién es el curso?», «¿qué voy a aprender?») no distingue nada y no cuenta. Así «¿tienen algo para vacas?» encuentra los cursos de bovinos sin vocabulario escrito en el código, y «¿sirve para vacas?» en un curso de bovinos no se toma por un tema que no cubre. Para GlobalVet se cargaron por el conector 17 fichas de prueba (una por curso, en borrador; a quién va dirigido y nivel inventados, lista en `data/cursos-globalvet/`, fuera de Git).

Segunda prueba en WhatsApp real, ya con las fichas aprobadas, dejó dos más:

- **«Soy estudiante de la UTT, ¿cuál me recomiendas?»** recibía la respuesta del descuento de estudiante: en el camino de recomendar, una respuesta aprobada ganaba con que se pareciera a medias (una sola palabra, «estudiante»). Ahora ahí sólo cuenta una que se parezca mucho (0.75); sin tema, se pregunta con qué trabaja.
- **«¿Y hay para vacas?»** no se tomaba como pedir cursos (faltaba el sustantivo: «hay cursos para…»). `HAS_FOR`: el verbo seguido de la preposición y un tema («hay para vacas», «tienen de gatos») pide cursos; no «hay para cuándo» ni «hay de pago».

Las 58 frases de las sondas de la segunda revisión dan las mismas respuestas que antes de estos ajustes.

## Memoria de la conversación (21 nov 2026)

El motor no recordaba nada de lo que la persona había dicho dos mensajes antes: «soy estudiante de la UTT, ¿cuál me recomiendas?» recibía «¿Qué tema te interesa?», y la respuesta a esa pregunta («vacas») caía en «sin intención» y recibía «esa pregunta todavía no la tengo a la mano». Primera pieza del plan de contexto aceptado por el dueño (sin esquema nuevo, sin IA):

- **Contestar la pregunta del asistente.** Si lo último que dijo el asistente fue «¿Qué tema te interesa?» (intención `courses`) y el mensaje siguiente nombra un tema («vacas», «trabajo con bovinos», «reptiles»), ese mensaje se lee como la respuesta y se recomienda con él (`topicAnswer` en `server/replies.mjs`, con la misma lectura que `recommend`: título, temario y ficha de cada curso). Si el tema no está en ningún curso de la marca, se dice claro y se ofrecen los que sí hay. Un «sí» o un «no sé» no cuentan como tema. El porqué dice «Contesta a «¿Qué tema te interesa?» del mensaje anterior».
- **Recordar con qué trabaja.** Al pedir una recomendación sin tema, antes de volver a preguntar se miran los mensajes anteriores de la persona en **esta** conversación (sus últimos 30, `saidBefore`), con la misma lectura del catálogo (`remembered` en `server/lib/sales-replies.mjs`): «tengo un rancho de bovinos y quiero aprender más» → dos mensajes después, «¿cuál me recomiendas?» responde «Por lo que me contaste antes, te pueden servir estos cursos…» con el curso de bovinos. El tema con el que contestó la vez pasada también queda en esa memoria. El porqué dice «Recomendación con lo que contó antes en esta conversación».
- **Lo que recibe la IA** (`server/memory.mjs`, [PLAN_MEMORIA_CONTEXTO.md](PLAN_MEMORIA_CONTEXTO.md)): la ficha del cliente lleva ahora, de esta conversación, **su perfil** si lo dijo («En esta conversación dijo que es estudiante»; de una lista fija: estudiante, técnico/a, pasante, principiante, profesional, egresado/a, `roleOf`) y **los cursos de la marca con los que coincide lo que contó** («Lo que ha contado apunta también a: Bovinos de leche»). Su texto libre nunca viaja: sólo palabras que casan con la lista o con el catálogo.
- **Alcance y privacidad.** Sólo mensajes de esta conversación (nunca de otra marca, nunca de otra conversación); nada se guarda aparte: se deriva de `messages` al responder, como el resto de la memoria. La simulación de Seguimientos no tiene historia, así que ahí no cambia nada.

Verificado con las frases exactas en `test/sales-replies.test.mjs` (tres conversaciones reales: recordar el rancho de bovinos, contestar «reptiles» a la pregunta y volver a pedir, «astronomía» sin curso y «sí» que no inventa una lista) y `test/memory-context.test.mjs` (perfil en la ficha de la IA; una frase hostil no pasa). Las 58 frases de las sondas dan las mismas respuestas.

## Objeciones con argumentos reales (22 nov 2026)

Segunda pieza del plan de contexto. Las tres objeciones más comunes recibían un texto fijo y amable que no decía nada del curso. Ahora llevan argumentos, pero **sólo con lo que ya es cierto en el catálogo o en una respuesta aprobada**: nada se inventa, no se ofrecen descuentos ni otro precio, y no se presiona con cupos o plazos que el CRM no conoce (sin esquema nuevo, sin IA):

- **«Está caro», «no me alcanza»** (`copy.objection` con `sessions` e `installments`): el precio vigente (con la promoción y hasta cuándo, si la hay), **lo que incluye ese precio** según el catálogo (número de sesiones si la apertura las tiene, modalidad, del día de inicio al de fin) y, si la marca tiene una **respuesta aprobada de pago que hable de pagar en partes** (`installments` en `server/lib/sales-replies.mjs`: las mismas palabras con que se pregunta más las de quien redacta: «partes», «plazos», «apartas con», «liquidas»), esa respuesta tal cual, como fuente de conocimiento. Cierra como antes: por este chat no hay otro precio; una persona revisa opciones. Una respuesta aprobada que se parezca mucho a la objeción (0.6) sigue ganando.
- **«Lo pienso», «lo consulto», «te aviso»** (`THINKING`, dentro de la intención `later`; `copy.thinking`): «tómate tu tiempo» y, **sólo para que lo tenga en cuenta**, lo que el catálogo dice hoy: la promoción vigente y hasta cuándo; los lugares que quedan si son 10 o menos (la misma regla que la respuesta de cupo); o, si no, que el curso inicia tal día y las inscripciones siguen abiertas. Invita a resolver la duda por aquí. «Espera», «un momento», «dame chance» no son pensarlo: siguen con «sin prisa».
- **«No tengo tiempo», «salgo tarde»** (`copy.timeObjection` con `sessions`): además de lo que el conocimiento aprobado dice de la grabación, el **calendario real** de la apertura (inicio, fin y sesiones) para que lo mida, y cómo preguntar por otra fecha.

Verificado con las frases exactas en `test/sales-replies.test.mjs`: «está muy caro» con y sin respuesta aprobada de partes (sin ella no se inventa), con promoción vigente y sin ella; «déjame pensarlo» y «lo voy a pensar» frente a «espera un momento»; «no tengo tiempo en esas fechas» con el calendario; la lectura de `THINKING` e `installments` con sus vecinos. Las sondas sólo cambian en estas tres respuestas.

Siguen del mismo plan: aprendizaje semanal desde las preguntas sin respuesta (revisión por el conector → borradores) y medir con IA real.

## Fuera de este bloque

- **Cambiar de curso en el mismo chat** fuera de un número de WhatsApp de toda la marca («mejor el de geriatría»).
- Sinónimos que el catálogo no tiene («vacas» no encuentra «ganado bovino»; «exóticos», «no convencionales»): la recomendación sólo ve palabras del catálogo. Se resuelve con el temario o con respuestas aprobadas.
- Programar un recordatorio a quien dice «pago en la quincena»; avisar de nuevo al equipo cuando alguien insiste en la espera (hoy la conversación sigue en la cola, sin aviso extra).
- Los audios.
- Sin probar con IA real, en producción ni con WhatsApp real; las pantallas de Certificados y del chat no se revisaron en el navegador en este trabajo.
