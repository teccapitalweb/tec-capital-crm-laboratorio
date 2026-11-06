# Plan: memoria y contexto de la IA

Estado: **implementado en la rama `feat/memoria-contexto`** (6 nov 2026), **sin esquema nuevo y sin cambio de versión**. Sin publicar.

## La idea en una frase

La IA no recuerda nada entre llamadas. Lo que «sabe» lo arma el CRM en cada respuesta. Este bloque mejora **qué se le entrega** (conocimiento relevante y memoria del cliente) y **qué aprende el equipo** (preguntas sin respuesta), sin tocar quién decide: precios, pagos, descuentos y reembolsos siguen siendo de reglas y personas.

## Qué se hizo

### 1. Selección inteligente del conocimiento (`server/retrieval.mjs`)
Antes se mandaba **todo** el conocimiento aprobado en cada llamada: barato con 6 entradas, caro y confuso con 300 por marca. Ahora se ordena por relevancia y sólo se entregan las mejores:

- **BM25** (puntuación estándar de búsqueda) con peso triple a la pregunta y sus variantes y doble al tema; raíces simples para plurales y conjugaciones.
- **Familias de sinónimos del negocio de cursos** (certificado ~ constancia ~ diploma ~ papel que acredite; grabación ~ no puedo conectarme ~ faltar; pago ~ transferencia ~ factura; requisitos ~ computadora ~ celular…). Mejoran lo que las palabras exactas no alcanzan.
- **Contexto reciente:** los últimos dos mensajes del cliente ayudan a entender «¿y cuánto dura?».
- **Tema detectado:** si el motor de reglas ya identificó el tema, esa entrada entra siempre.
- **Presupuesto:** `AI_KB_TOP_K` entradas (6 por omisión, 1–20) y un máximo de caracteres. Un conocimiento chico (≤ K) se manda completo.
- **Si nada se parece** a la pregunta, **no se llama a la IA** (se ahorra la llamada y no se invita a inventar).
- Sin servicios externos ni costo; determinista, así que se puede explicar y probar por qué salió cada entrada. Cada respuesta con IA deja «Contexto: N de M entradas» en su «por qué respondió».

### 2. Memoria del cliente (`server/memory.mjs`)
Ficha **derivada de las tablas verdaderas** (no hay una segunda copia que se desactualice): desde cuándo tiene contacto con la marca, cuántas conversaciones y por qué canales, por qué otros cursos ha preguntado y en qué etapa, si ya está inscrito y si tiene un pedido pendiente. Se entrega a la IA para personalizar y no repetirse.

- **Sólo de la marca de la conversación.** Nada de otras marcas aunque la persona exista en varias.
- **Sin teléfono, correo, importes, notas internas ni etiquetas del equipo** (pueden decir cosas que no deben orientar una respuesta).
- Corta (máx. ~700 caracteres). Va marcada como contexto, nunca como fuente de precios, fechas ni promesas. Lo que se le entregó queda visible en el «por qué respondió».
- Un pedido pendiente se le indica a la IA como «lo ve una persona»: no confirma ni cambia nada.

### 3. Preguntas que no supimos responder (Catálogo → Conocimiento)
Las preguntas de los últimos 30 días que el motor no pudo contestar con conocimiento aprobado, **agrupadas por parecido** («¿dan beca?», «hay becas…», «tienen beca…» cuentan como una) y ordenadas por cuántas veces se repiten, con el botón **Crear respuesta**, que abre el editor con la pregunta ya escrita (entra como borrador; administración aprueba). `GET /api/replies/gaps` (alcance por marca; clientes 403). Es el ciclo de aprendizaje: lo que más se pregunta y falta, se cubre primero.

## Evidencia

- 172 pruebas. La de selección usa un conocimiento de 30 entradas (10 del negocio y 20 de relleno): cinco paráfrasis que no comparten palabras con la pregunta guardada traen la entrada correcta primero; la memoria se prueba con una persona en dos marcas (no se filtra nada de la otra, sin teléfono ni correo); los huecos agrupan cuatro formas de preguntar lo mismo y no se ven desde otra marca.
- **Con la API real y 33 entradas aprobadas:** 4 llamadas con **884 tokens de entrada en promedio** (con 6 entradas, antes, eran ~1,300). Respuestas correctas: constancia → certificado; «un día no puedo conectarme» → grabación; «quién da las clases» → docentes sin inventar perfiles.

## Límites y lo que sigue

- Los sinónimos son una lista a mano para el negocio de cursos; si una consultora usa jerga distinta, se agregan variantes en el conocimiento. Búsqueda semántica con embeddings queda para cuando el conocimiento pase de cientos de entradas por marca.
- **Resumen de conversaciones largas** (la IA sigue viendo los últimos 6 mensajes): necesita esquema nuevo y una llamada extra a la IA; es el siguiente bloque.
- La memoria no incluye notas ni etiquetas a propósito. Memoria a largo plazo con permiso explícito del cliente (preferencias, objeciones recurrentes) y una ficha única entre canales requieren decisiones de privacidad.
- Sin llamadas de voz todavía.
