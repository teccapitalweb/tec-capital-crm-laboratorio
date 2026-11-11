# Motor de respuestas más preciso (11 nov 2026)

Rama `feat/motor-preciso`. Sin esquema nuevo.

## Por qué

Con Claude ya funcionando en producción, el usuario preguntó si el motor tiene algún reconocimiento o aproximación para no gastar tokens de más. Lo tiene, y se midió:

1. **Reglas de intención** (`PATTERNS` en `server/replies.mjs`): saludo, precio, fechas, temario, inscripción, pago, asesor… Contestan con el catálogo. Cero tokens.
2. **Conocimiento aprobado** (`bestMatch`, parecido ≥ 50 %, y el tema reconocido). Cero tokens.
3. **Claude**, sólo si nada de lo anterior aplica **y** hay conocimiento relacionado que mandarle (`server/retrieval.mjs`: BM25 con sinónimos del negocio, las más relevantes y con tope de caracteres). Si nada del conocimiento se parece, no se llama: se da la respuesta genérica y la pregunta queda como hueco de conocimiento.

Además: tope mensual de llamadas (`AI_MONTHLY_CALL_LIMIT`), tope opcional de tokens (`AI_MONTHLY_TOKEN_LIMIT`), esfuerzo bajo y respuestas cortas.

## Lo que se midió

Banco de 49 frases realistas contra el conocimiento de prueba de GlobalVet (motor simulado, sin gasto):

| | Antes | Después |
|---|---|---|
| Llegan a la IA | 6 de 49 | 7 de 49 |
| Ruta distinta a la esperada | 14 | 6 |
| De ésas, **respuesta equivocada** dada por reglas | 8 | 0 |

El gasto ya era bajo. El problema real eran reglas demasiado amplias que **contestaban mal sin costo**:

| Frase | Antes | Ahora |
|---|---|---|
| «¿El curso vale la pena?» | precio (por «vale») | sin intención: conocimiento, IA o genérica |
| «¿Qué voy a saber hacer cuando termine?» | fechas (por «cuando») | sin intención |
| «¿Cuándo me mandan el link de la clase?» | fechas | sin intención |
| «¿Cuánto tiempo tengo para pagar?» | «¿Cuánto dura el curso?» | pago |
| «¿Quién da el curso?» | «¿Para quién es el curso?» | ficha de la edición (docente) |
| «¿A qué hora son las clases?» | «¿Cuánto dura el curso?» | ficha de la edición |
| «¿Me pueden llamar?» | respuesta genérica | pasa a una persona |
| «¿Aplica para alguien que apenas empieza?» | pasaba a una persona (por «alguien») | sin intención |

Las 6 diferencias que quedan no son respuestas falsas: «¿Hay descuentos?» responde la promoción vigente del catálogo; cuatro preguntas sin nada parecido en el conocimiento reciben la respuesta genérica (y quedan como hueco, sin gastar); y el plazo de pago recibe la información general de pago.

## Qué cambió

- `PATTERNS`: reglas más estrechas para precio, fechas, duración, asesor y agradecimiento; nuevas formas de inscripción («cómo me apunto», «quiero entrar»), promo, docente, hora, plataforma y «¿se graba?». Una regla puede llevar una condición (4.º elemento). «apuntes» no es «apuntarme».
- `fromKnowledge`: con un tema reconocido no se usa una respuesta aprobada de **otro** tema reconocido aunque se parezca en palabras.
- Chat: los mensajes que redactó la IA dicen **«Automatización · IA»** (antes todos decían «Reglas»). `messageList` añade `ai_drafted` a partir de `reply_log` (motivo «Proveedor de IA: …»).
- `test/replies-intents.test.mjs`: el banco de frases como prueba, para que una regla futura no vuelva a ensancharse sin que se note.

## Para gastar todavía menos

- **Aprobar más respuestas** (Catálogo → Conocimiento, y las «preguntas sin respuesta»): cada una deja de llegar a la IA.
- `AI_MONTHLY_TOKEN_LIMIT` en Railway para un tope de tokens.
- `AI_MODEL=claude-haiku-5-5` es mucho más económico; responde con menos criterio. Es decisión del negocio.

## Pendiente

- Medir con el conocimiento real de cada consultora (este banco usa el de prueba).
- Proponer como borrador de conocimiento las respuestas que redacta la IA, para que una persona las apruebe y dejen de costar.
