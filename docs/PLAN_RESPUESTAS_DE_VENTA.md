# Respuestas de venta: pagos, constancia, posventa y menos IA (21 nov 2026)

Rama de trabajo (sin publicar). Una migración con nombre: `replies/0001-certificate-name-requests` (tablas `certificate_name_requests` y `certificate_name_events`; esquema `41+32.c05a5695`). Las dos migraciones anteriores de esta rama nunca llegaron a `main` y se fundieron en ésta.

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

## Fuera de este bloque

- **Cambiar de curso en el mismo chat** fuera de un número de WhatsApp de toda la marca («mejor el de geriatría»).
- Sinónimos que el catálogo no tiene («vacas» no encuentra «ganado bovino»; «exóticos», «no convencionales»): la recomendación sólo ve palabras del catálogo. Se resuelve con el temario o con respuestas aprobadas.
- Programar un recordatorio a quien dice «pago en la quincena»; avisar de nuevo al equipo cuando alguien insiste en la espera (hoy la conversación sigue en la cola, sin aviso extra).
- Los audios.
- Sin probar con IA real, en producción ni con WhatsApp real; las pantallas de Certificados y del chat no se revisaron en el navegador en este trabajo.
