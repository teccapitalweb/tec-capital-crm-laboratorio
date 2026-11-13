# Asistente sin callejones (13 nov 2026)

Publicado en `main` (13 nov 2026). **Sin esquema nuevo.** Falta probarlo en producción y con WhatsApp real.

## Para qué

Con WhatsApp real funcionando, el usuario notó que el asistente a veces contestaba «No quiero hacerte perder tiempo: le paso tu pregunta a una persona…» cuando la persona sólo había escrito algo corto. Pidió arreglar ese flujo.

## Qué pasaba (medido)

Se pasaron 94 mensajes cortos y de trato por la simulación («ok», «va», «sí», «no», «disculpa», «una pregunta», «espera», «lo voy a pensar», «¿eres un bot?», «👍», «?»…):

| | Antes | Ahora |
| --- | --- | --- |
| Caían en «no reconocida» | 79 de 94 | 5 de 94 (las que sí son preguntas de fondo) |

Tres causas:

1. **Los mensajes de trato contaban como pregunta sin respuesta.** Dos seguidos («disculpa» y «una pregunta») bastaban para pasar el chat a una persona.
2. **Las respuestas buenas también contaban.** Una pregunta contestada por la IA o por el conocimiento aprobado se guarda con intención «no reconocida», y la cuenta las sumaba: en modo Autónomo, la **segunda** pregunta seguida que la IA contestaba bien ya pasaba el chat a una persona.
3. **Coincidencias flojas con el conocimiento.** «Entiendo» se contestaba con la entrada del certificado (el trozo «ent» coincidía con «entregan»); «¿tienen sucursal?» también («tienen» ≈ «tiene validez»); «a ver» con la de la grabación.

## Qué hace ahora

**1. Mensajes de trato con su propia respuesta** (por reglas, sin gastar una consulta de IA):

| La persona escribe | Intención | El asistente |
| --- | --- | --- |
| «ok», «okey», «entiendo», «de acuerdo», «👍», «eso es todo» | `thanks` | Acusa recibo; el segundo seguido no repite el mismo texto |
| «sí», «va», «claro», «quiero» (sin una pregunta pendiente) | `affirm` | «¿Qué te cuento de…?» con opciones |
| «no», «no gracias», «ya no me interesa», «no quiero inscribirme» | `decline` | Se despide sin insistir y **sin mandar la ficha** |
| «espera», «lo voy a pensar», «luego te aviso» | `later` | «Sin prisa…» |
| «bye», «hasta luego» | `bye` | Despedida |
| «disculpa», «una pregunta», «¿siguen ahí?», «no entiendo», «?», «a ver» | `help` | «Aquí estoy…» con opciones y botón de asesor |
| «ver opciones», «¿qué puedes hacer?» | `menu` | Las opciones (o el primer paso del flujo de bienvenida) |
| «¿eres un bot?», «¿quién eres?» | `identity` | Dice que es el asistente automático y cómo pedir una persona |
| «está caro», «no me alcanza» | `objection` | Precio vigente del catálogo y opción de asesor; **no ofrece descuentos** |
| «¿hay cupo?», «¿quedan lugares?» | `seats` | Cupo del catálogo (cifra sólo si quedan 10 o menos); no dice que aparta |
| «¿qué otros cursos tienen?» | `courses` | Otros cursos activos **de la misma marca** |

También: «de qué trata» va al temario; «informes», «detalles», «cuéntame» a la ficha; «dónde están ubicados», «es en vivo» a modalidad.

**2. «Sí» y «no» se leen contra el último mensaje del asistente:**

- Después de «¿Te cuento el precio o las fechas?», un «sí» contesta **las dos cosas**.
- Después de «¿Quieres apartar tu lugar?» (o del precio, que invita a inscribirse), un **«sí» claro** («sí», «sí quiero», «me interesa») sigue el camino de siempre de «Quiero inscribirme». «Ok», «va» o «vale» sólo acusan recibo: no arman un pedido. Una pregunta con varias opciones, como la de la bienvenida («¿…el temario, el precio o cómo inscribirte?»), nunca se toma como inscripción.
- Después de la propuesta de pasar con una persona: «sí» pasa a un asesor; «no» muestra las opciones.

**3. Sin respuesta: tres escalones en lugar de un pase de golpe**

1. Primera vez: «Esa pregunta todavía no la tengo a la mano…» con botones **Precio · Fechas · Hablar con asesor**.
2. Al llegar al máximo de la marca (2 por omisión): **pregunta** «¿Quieres que te pase con una persona del equipo?» con botones **Sí, con un asesor · Ver opciones**. El chat sigue con el asistente.
3. Si después de eso tampoco hay respuesta: pasa a una persona («Para no hacerte dar más vueltas…»).

La cuenta sólo suma preguntas **sin contestar** (ni conocimiento aprobado ni IA). Los mensajes de trato ni suman ni reinician; pedir las opciones, decir «no» a la persona, una respuesta buena o un pase a una persona la reinician.

**4. Si la IA contesta, no hay escalón.** En modo Autónomo el plan lleva las dos salidas; cuando el texto de la IA pasa el validador, la respuesta sale sin botones de «no la tengo», sin propuesta y sin pase.

**5. Parecido con el conocimiento más estricto** (`similarity`): un trozo de menos de 4 letras no coincide por prefijo, y las palabras de relleno («tienen», «ver», «nada», «algo»…) sólo suman si otra palabra con contenido también coincide.

## Lo que no cambió

- Pasan **siempre** a una persona, igual que antes: pedir un asesor, queja o reembolso, avisar de un pago, edición no disponible, inscripción sin venta activa. La baja de mensajes sigue yendo primero.
- Precio, fechas y cupo salen del catálogo vigente. Ningún texto nuevo promete descuentos, lugares apartados ni que «ya viene una persona» si no hubo pase.
- El flujo de bienvenida manda cuando la persona pulsa uno de sus botones; la propuesta de asesor lleva sus propios botones y no mueve el recorrido.

## Cambio de significado de un ajuste

Operación → Automatización → «Máximo sin reconocer antes de escalar» ahora se llama **«Sin respuesta antes de proponer un asesor»**: al llegar a ese número se pregunta; el pase ocurre en el siguiente. Con el valor 1, la primera pregunta sin respuesta ya propone una persona.

## Dónde está

- `server/replies.mjs`: reglas (`PATTERNS`), `SOFT_INTENTS`, lectura del último mensaje (`lastBot`, `YES`, `STRONG_YES`), escalones (`out.miss`, `out.ifAnswered`), `unknownStreak`.
- `server/reply-copy.mjs`: textos nuevos (`affirm`, `decline`, `later`, `bye`, `help`, `menu`, `identity`, `seats`, `courses`, `objection`, `offerHuman`, `thanksAgain`) y los de «sin respuesta» reescritos.
- `server/ai-provider.mjs`: `similarity` y `WEAK`.
- `server/simulator-personas.mjs`: el perfil «Pregunta fuera de guion» ahora acepta la propuesta de asesor.
- Etiquetas de las intenciones nuevas en Conocimiento, Evaluación y Presentación.

## Verificación

- `test/assistant-flow.test.mjs` (4 pruebas): parecido con el conocimiento; banco de 66 frases de trato y de control por la simulación; conversaciones reales del laboratorio con los tres escalones, «sí»/«no» por contexto, «ok/va/vale» que no inscriben, reinicio de la cuenta tras un pase; y modo Autónomo con una IA de mentira (tres respuestas buenas seguidas no pasan a nadie; las inválidas siguen los escalones).
- Se ajustaron cuatro pruebas que fijaban el pase a la segunda (`replies`, `flows`, `replies-intents`, y el perfil del simulador).
- Suite completa: **213 pruebas**. `npm run check` limpio.
- Revisión independiente del código: siete hallazgos, todos corregidos con su prueba (un «ok» tras «¿Quieres apartar tu lugar?» inscribía; «¿eres un bot? ponme con un asesor» no pasaba a una persona; «ya pagué pero… cara» perdía el pase obligatorio; «quiero mi dinero» no era reembolso; la negación vetaba inscripciones legítimas; la cuenta no se reiniciaba tras un pase; el texto de cupo empezaba con «Sí»).
- En el navegador, demo local a 375 px: botones de 40 px, sin desborde; la propuesta de asesor y «Ver opciones» funcionan al tocarlos. La vista de escritorio no se pudo capturar (la ventana estaba oculta); este bloque no cambia pantallas del equipo salvo una etiqueta.

## Límites y pendientes

- Las reglas son en español de México y por palabras: una frase rara puede caer en la intención equivocada. Ante la duda, cae en «no reconocida» y la resuelven el conocimiento o la IA.
- «Ya no me interesa» sólo despide: no cancela seguimientos ni cambia la etapa (posible mejora).
- Los textos nuevos no se pueden editar por marca desde la interfaz (viven en `reply-copy.mjs`).
- **Sin probar en producción** ni con WhatsApp real: los botones salen como botones de respuesta de Meta (máximo 3, 20 caracteres; se cumplen).
- El banco de evaluación ya sembrado en producción no cambia; conviene volver a correrlo tras publicar.
