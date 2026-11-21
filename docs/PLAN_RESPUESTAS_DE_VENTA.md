# Respuestas de venta: pagos, constancia, posventa y menos IA (21 nov 2026)

Rama de trabajo (sin publicar). Una migración con nombre nueva: `replies/0001-certificate-details`.

## Por qué

El dueño pidió respuestas «más pro», enfocadas a vender, y gastar menos en IA. Se midió el motor de tres pisos (reglas → conocimiento aprobado → Claude) con dos fuentes que se quedan fuera de Git:

- un análisis de **7,117 conversaciones** reales de una consultora de cursos (sólo conteos por intención: **19,981 mensajes** de clientes), y
- un **banco de 173 frases y 12 conversaciones** escritas a mano con esas proporciones, pasado por el simulador del motor en una base local de usar y tirar, con el catálogo de 17 cursos de prueba y dos versiones de conocimiento: **A** = las 6 respuestas de ejemplo que trae una marca nueva, **B** = A más el CSV de ejemplo del repositorio (10 aprobadas). Sin IA real (proveedor simulado: se sabe si se le habría llamado, no qué habría dicho).

Lo que salió: el motor contestaba muy bien lo que más llega (la frase del anuncio, «información», «Sí, deseo inscribirme», «gracias»), pero **de las preguntas sólo 3 de cada 10 salían bien, 1 de cada 3 iba a la IA y 1 de cada 4 recibía una respuesta equivocada sin costo**, sobre todo en pagos y en lo que pasa después de pagar.

## Qué cambió

| # | Hueco medido | Qué hace ahora | Dónde |
| --- | --- | --- | --- |
| 1 | Todo lo que sonaba a pago recibía «Puedes pagar con…» | El pago se parte: **cómo pago** (igual que antes), **ya pagué** (acuse con el estado real del pedido y pasa a una persona; si ya está en revisión no vuelve a pedir el comprobante), **pago después** («mañana», «la quincena»: acuse sin presionar, la vigencia de su pedido y, si pregunta si se lo apartan, «el lugar queda asegurado cuando se confirma el pago»), **¿ya verificaron?** (el estado del pedido; en revisión o sin pedido avisa al equipo), **factura**, **meses o en partes**, **varias personas** y **datos de la cuenta** (sólo con una respuesta aprobada que de verdad hable de eso; si no, pasa a una persona con un texto honesto). Nunca confirma un pago. | `server/lib/sales-replies.mjs` (`paymentKind`), `server/replies.mjs`, textos en `server/reply-copy.mjs` |
| 2 | «Mi nombre para la constancia es…» recibía el texto del certificado o **creaba un pedido** | Se reconocen los datos (nombre completo, correo, teléfono): con seguridad cuando dice para qué son o los ofrece; un correo, un teléfono o un nombre sueltos sólo si ya hay un pedido en la conversación. Se acusa lo que se anotó, **no se crea otro pedido** y se guarda en `certificate_details` (una fila por conversación). Al emitir el certificado de esa inscripción, **ese nombre es el del certificado**. También cuando la conversación ya espera a una persona (después de «ya pagué»). | migración `replies/0001`, `server/replies.mjs`, `server/certificates.mjs` |
| 3 | «Sí, me interesa» (botón de una plantilla de seguimiento) **reenviaba la ficha** | Fuera de la pregunta de la ficha sigue el camino de la inscripción del curso de la conversación (el mismo de «Quiero inscribirme»). Justo después de la ficha se contesta como siempre. | `server/replies.mjs` |
| 4 | Frases claras que iban a la IA o a la ficha equivocada | Reglas nuevas, sin gasto: «buen día»; inscripción como sustantivo o decisión («el proceso de inscripción», «apartar mi lugar», «lo tomo», «me apunto»), sin tocar «¿cuánto cuesta la inscripción?»; «¿hasta qué día me puedo registrar?» da la fecha y no crea el pedido; «número de cuenta»; «me **puede** llamar»; **validez oficial, SEP, cédula, valor curricular**: sólo lo que consta (certificado digital, quién lo emite según Certificados, folio y QR) y nunca «Sí» a una validez oficial (la respuesta anterior era riesgosa); «¿quedan espacios?» es cupo, y sin lugares contados pero con el tamaño del grupo dice «el grupo es de 30 lugares, cupo limitado»; la duración se contesta con el inicio, el fin y las sesiones de la apertura de la conversación; «¿hay repetición?» es grabación aunque mencione el horario. | `PATTERNS` en `server/replies.mjs` |
| 5 | Con 6 respuestas aprobadas o menos, **todo** el conocimiento iba a la IA ante cualquier pregunta sin intención | `rankKnowledge` exige el mismo parecido mínimo con pocas entradas que con muchas (modo `pocas`). Lo ajeno no llama a la IA: recibe la respuesta de «no la tengo» y queda como hueco de conocimiento. | `server/retrieval.mjs` |
| 6 | «¿Cuál me recomiendas?», «tengo un rancho», «¿tienen algo de reptiles?» iban a la IA | Recomendación con el catálogo de la marca (título y temario de los cursos con apertura disponible) y familias de palabras del ramo (especies y temas): hasta 5 cursos con su inicio y precio vigentes. Sin especie ni tema, pregunta con qué trabaja en lugar de soltar la lista; «soy estudiante, ¿me sirve?» contesta con la respuesta aprobada de requisitos si existe. No inventa niveles ni requisitos. | `recommend` en `server/lib/sales-replies.mjs` |
| 7 | «¿Dónde entro?», «no me llegó el enlace» iban a la IA | Con una inscripción activa y los accesos de la apertura listos (Ventas → Accesos), **se reenvían** y la entrega queda anotada como reenvío del asistente. Si no hay inscripción, si los accesos no están listos o si algo «no abre» / «se cortó», pasa a una persona diciendo qué pasa. | `server/modules/course-access/module.mjs` (`replies.useAccess`) |
| 8 | Después de pasar a una persona, **nada** recibía respuesta (ni «¿ya verificaron mi pago?» ni una queja) | **Un acuse por espera**: «Ya le avisé al equipo; en cuanto una persona esté disponible te contesta por aquí» (con el estado del comprobante si está en revisión). El asistente no retoma la conversación. No aplica si alguien del equipo la tomó o ya escribió, en «Apagado» o «Sugerir», ni a un archivo (un comprobante sigue su camino). | `server/operations.mjs` (`useCustomerWaiting`) y `ackWhileWaiting` en `server/replies.mjs` |
| 9 | Pequeñas | «No tengo tiempo», «estoy de guardia» (objeción de tiempo: lo que dice la respuesta aprobada de la grabación y cómo preguntar por otra fecha); «¿va a haber otra fecha?» y «avísame de la siguiente» (la fecha vigente; avisar lo pide al equipo); «¿hay descuento?» sin promoción vigente lo dice claro (para un grupo, una persona); quien busca trabajo recibe que este chat es de inscripciones; «gracias» de quien ya pagó no le ofrece inscribirse; «¿manejan diplomados?» son otros cursos, no el certificado; «ahorita no, más adelante». | `server/replies.mjs`, `server/reply-copy.mjs` |

Dos intenciones nuevas en la bitácora (`reply_log`): `access` (pide sus accesos) y `cert_data` (datos para la constancia), con su etiqueta en Conocimiento, Evaluación y Presentación. Las demás piezas son variantes dentro de las intenciones de siempre (`payment`, `certificate`, `schedule`, `courses`…), y el motivo de cada respuesta dice cuál fue.

## Medición antes y después

Mismo banco y misma herramienta antes (commit base `7e8e9db`) y después, en local, sin IA real. «IA» = el motor habría llamado a Claude. Calidad por revisión manual: una respuesta que no cambió conserva su calificación original; las que cambiaron se calificaron de nuevo (*buena* contesta lo que se preguntó, *parcial* algo relacionado, *persona* pasa a una persona, *genérica* «no la tengo a la mano» sin gasto, *mala* contesta otra cosa, *riesgosa* afirma algo que no consta).

**Por frase (173):**

| | Buena | Parcial | Persona | IA | Genérica | Mala | Riesgosa |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A antes | 73 | 25 | 5 | **50** | 0 | 19 | 1 |
| A después | 122 | 13 | 27 | **5** | 6 | 0 | 0 |
| B antes | 77 | 25 | 5 | **32** | 14 | 19 | 1 |
| B después | 124 | 13 | 27 | **5** | 4 | 0 | 0 |

**Ponderado por lo que se pregunta de verdad** (cada intención pesa lo que pesa en los mensajes reales):

| | Buena | Parcial | Persona | IA | Genérica | Mala | Riesgosa |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Todo el tráfico, A antes | 66.4 % | 13.9 % | 1.0 % | 11.2 % | 0 % | 7.3 % | 0.2 % |
| Todo el tráfico, A después | 89.5 % | 4.4 % | 5.3 % | 0.3 % | 0.6 % | 0 % | 0 % |
| Sólo preguntas, A antes | 28.8 % | 11.1 % | 3.2 % | 32.2 % | 0 % | 23.9 % | 0.8 % |
| Sólo preguntas, A después | 74.2 % | 5.6 % | 17.3 % | 0.9 % | 2.0 % | 0 % | 0 % |
| Sólo preguntas, B antes | 30.5 % | 11.1 % | 3.2 % | 17.3 % | 13.2 % | 23.9 % | 0.8 % |
| Sólo preguntas, B después | 74.9 % | 5.6 % | 17.3 % | 0.9 % | 1.3 % | 0 % | 0 % |

**Llamadas a la IA en el banco:** A 50 → 5; B 32 → 5. Las 5 que quedan son preguntas sin regla ni respuesta aprobada que sí se parecen al conocimiento (en A: «¿es básico o avanzado?», «¿cómo sé que esto es real?», «¿tienen página o redes?», «soy de Colombia, ¿puedo tomarlo?», «mejor el de geriatría»).

Más «persona» es a propósito: factura, meses, varias personas, datos de la cuenta, avisar de la siguiente fecha y los accesos sin inscripción ya no reciben un texto equivocado; los atiende alguien del equipo. En el simulador las frases no tienen pedido ni inscripción, así que «¿dónde entro?» o «¿ya verificaron?» pasan a una persona; en una conversación con pedido o inscripción se contestan con su estado o se reenvían los accesos (eso lo cubren las pruebas).

**Las 12 conversaciones:** «Sí, me interesa» a media conversación ahora crea el pedido; «en la quincena pago» y «ahorita le mando el pago» reciben la vigencia de su pedido sin crear otro; el nombre para el certificado se anota aunque la conversación ya espere a una persona; después de un pase, el primer mensaje recibe el acuse y los siguientes no (una vez por espera); la objeción de tiempo y «avísame cuando lo vuelvan a abrir» tienen su respuesta. Sigue igual: «mejor el de geriatría» no cambia de curso y el precio siguiente sale del curso anterior.

Cautela: la calidad la calificó una sola revisión (la misma que hizo los cambios), el banco se redactó a mano con proporciones de otro ramo y nada se probó con IA real.

## Reglas que se respetan

- Precio, fechas, cupo y lugares salen del catálogo vigente; quién emite el certificado, de Certificados. Ningún texto nuevo lleva una cifra escrita a mano.
- El asistente **nunca confirma un pago**: «ya pagué» pasa a una persona; «¿ya verificaron?» sólo lee el estado del pedido.
- Lo que el catálogo o la configuración no saben (factura, meses, varias personas, cuenta, validez oficial, otra fecha) se contesta con una respuesta aprobada que lo diga o lo atiende una persona.
- Todo por marca: la recomendación sólo usa cursos de la marca de la conversación; los datos para la constancia, sólo su conversación.

## Pruebas

- `test/sales-replies.test.mjs`: la lectura fina (pago, datos, accesos, validez, recomendación) con sus casos vecinos; la migración sobre una base ya publicada (`assertSchemaCurrent`); y de punta a punta: cada tipo de pago, las reglas nuevas con su vecino que no cambia, la recomendación, el conocimiento chico que ya no llega a la IA (y lo parecido que sí), una respuesta aprobada de factura, «Sí, me interesa» antes y después de la ficha, pagar después y el estado con un pedido real, los datos para la constancia (sin pedido nuevo) y el certificado emitido con ese nombre, el reenvío de accesos tras validar el comprobante, el acuse una sola vez por espera y nada en «Sugerir».
- `test/real-mode.test.mjs`: cada texto nuevo de `reply-copy.mjs` comprobado en modo real (ninguno dice prueba ni ejemplo).
- El resumen de conversación (`server/summaries.mjs`) no cuenta el acuse como respuesta: el siguiente paso sigue siendo «Responder a su último mensaje».
- El perfil «Sensible al precio» del simulador ya no pregunta por meses sin intereses (ahora eso pasa a una persona y ese perfil es el que termina indeciso solo); dice que le parece caro.
- Se ajustaron otras pruebas que fijaban el comportamiento que se corrige: `replies-resume` (tras pedir una persona ahora hay un acuse, una sola vez), `replies-learn` y `mcp-recorridos` (sus preguntas «para la IA» no se parecían a nada del conocimiento: ahora comparten alguna palabra), y además: «cuando me mandan el link de la clase» ya no es «no reconocida» sino posventa (`replies-intents`); la frase de varias preguntas «¿…y tiene certificado oficial?» ya no se contesta con «Sí» (se movió a «¿…y tiene certificado?» y se añadió la de «oficial»); un conocimiento chico ya no se manda completo (`memory-context`); y la prueba del modo autónomo usa una pregunta que sí se parece al conocimiento para llegar a la IA (`assistant-flow`).

## Fuera de este bloque

- **Cambiar de curso en el mismo chat** fuera de un número de WhatsApp de toda la marca («mejor el de geriatría»): sigue yendo a la IA y el precio siguiente sale del curso anterior.
- Confianza («¿cómo sé que es real?», «¿tienen página?»), nivel («¿es básico o avanzado?»), otro país y moneda: siguen en conocimiento o IA. Conviene aprobar respuestas para ellas.
- Programar un recordatorio a quien dice «pago en la quincena»; subir la prioridad en la bandeja cuando escribe «nadie me contesta».
- Los audios.
- Ver en una pantalla del equipo los datos para la constancia (hoy se ven en el chat y van al certificado).
- Sin probar con IA real, en producción ni con WhatsApp real. Las calificaciones de calidad son una revisión manual.
