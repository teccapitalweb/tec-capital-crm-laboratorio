# El asistente aprende de la IA (11 nov 2026)

Rama `feat/aprender-y-pulir`. Sin esquema nuevo.

## Para qué

El motor contesta primero con reglas y con el conocimiento aprobado, y sólo llama a Claude cuando nada de eso alcanza. Cada llamada cuesta y, sobre todo, la misma pregunta volvía a llamar a la IA una y otra vez. Ahora, cuando Claude redacta una respuesta y el motor la acepta, **queda como borrador de conocimiento**. Una persona lo revisa y lo aprueba; desde entonces esa pregunta se contesta sola, sin llamar a la IA.

## Cómo funciona

1. Un cliente pregunta algo que no reconocen las reglas ni el conocimiento aprobado.
2. Claude redacta con el conocimiento aprobado; el validador de siempre acepta o descarta el texto.
3. Si se acepta, el cliente recibe la respuesta **y** se guarda un borrador (`knowledge_entries`, `status='draft'`, `created_by NULL`, tema `general`, ligado al curso de la conversación).
4. En **Catálogo → Conocimiento** aparece con la etiqueta **«Borrador de la IA»** y una nota de qué revisar.
5. Al **aprobarlo**, la pregunta se contesta con el conocimiento (sin costo). Al **archivarlo** sin haberlo aprobado nunca, se **borra** con su historial.

Un borrador **nunca** se usa para responder: sólo lo aprobado.

## Cuidados con los datos de las personas

El proveedor recibe la memoria del cliente (su nombre y lo que ha preguntado), así que una respuesta aceptada puede traer algo suyo. Por eso:

- De la **pregunta** se quitan correos, teléfonos (con o sin separadores) y el nombre de quien la hizo.
- De la **respuesta** se quita el saludo inicial con nombre. Si después todavía trae el nombre en cualquier parte, un correo, un teléfono o una cifra larga, **no se aprende** de ella.
- Tampoco se aprende de respuestas que hablan de la historia de esa persona («como ya preguntaste…», «tu pedido», «tu pago»).
- Nada con precios: el precio vigente sale del catálogo.
- No se duplica: si ya hay una entrada con la misma respuesta o una pregunta muy parecida, no se crea otra.
- Tope de **30 borradores de la IA sin revisar** por marca (y el tope general de 300 entradas).
- Sólo aprende del proveedor real (`AI_PROVIDER=claude`); el motor simulado no genera borradores.
- Aprender nunca bloquea la respuesta: si algo falla, el cliente recibe su mensaje igual.

La revisión humana sigue siendo la última barrera: la nota del borrador pide comprobar que no mencione a ninguna persona.

## Verificación

`test/replies-learn.test.mjs`, con un Anthropic de mentira (`ANTHROPIC_BASE_URL`): borrador limpio tras una respuesta aceptada; el borrador no se usa hasta aprobarlo; precio, teléfono, nombre e historia del cliente no generan borrador; el nombre se quita de la pregunta; archivar un borrador de la IA lo borra; tras aprobar, la misma pregunta ya no llama a la IA y el contador de llamadas coincide.

## Pendiente

- Verlo en producción con Claude real.
- Avisar en Mi día cuando haya borradores de la IA por revisar (hoy se ve en Conocimiento y en Actividad → Resultados de la prueba).
