# Guía para cargar el contexto de una consultora

Para que la IA (y las respuestas automáticas en general) responda bien, necesita **conocimiento real y aprobado** de cada marca. Esta guía dice qué reunir, cómo escribirlo y cómo cargarlo. La plantilla se descarga en el CRM: Catálogo → Conocimiento → **Importar preguntas (CSV)** → *Descargar plantilla*.

## Cómo funciona (en una frase)

La IA sólo puede afirmar lo que está en el **conocimiento aprobado** de la marca y en el **catálogo** (precio, fechas, cupo). Todo lo que se importa entra como **borrador**; una persona de administración lo revisa y lo aprueba. Lo que no está aprobado no se usa.

## Qué reunir por consultora

1. **Quiénes son y cómo hablan:** una o dos frases sobre la marca y el tono (cercano, formal, técnico). Sirve para revisar que las respuestas suenen a la marca.
2. **Las 20 o 30 preguntas que más les hacen** los clientes, escritas como las haría un cliente. Mira sus chats reales o pregunta a quien atiende.
3. **La respuesta real a cada una**, corta y completa, tal como la daría una persona del equipo.
4. **Políticas que casi siempre se preguntan:** certificado o constancia, pagos y facturación, inasistencias y reposiciones, cancelación y reembolso, grabaciones, requisitos, acceso a la plataforma.
5. **Lo que NO debe prometer la IA** (por ejemplo, devoluciones o descuentos): para esos temas la respuesta correcta es «lo revisa una persona del equipo».

## Reglas para escribir las respuestas

- **Sin precios, fechas ni cupos.** Eso sale del catálogo vigente. Una respuesta con importes se rechaza al importar.
- **Una respuesta por pregunta**, de 10 a 1,500 caracteres, completa y sin rodeos.
- **No inventes.** Si algo depende de la edición o del curso, escribe cómo se maneja en general o deja que lo confirme una persona.
- **Otras formas de preguntarlo** (columna `variantes`, separadas por `;`): sinónimos como «constancia; diploma; tiene validez». Ayudan a que la IA reconozca la pregunta.
- **Curso (opcional):** si la respuesta sólo aplica a un curso, escribe su nombre exacto; si aplica a toda la marca, déjalo vacío.

## La plantilla

Una fila por pregunta, con las columnas `marca, pregunta, respuesta, tema, curso, variantes`. Trae 14 preguntas típicas de una consultora de cursos; cada respuesta empieza con **COMPLETAR:** y dice qué escribir. **El sistema rechaza las filas que sigan diciendo COMPLETAR**, así que nada a medias entra por accidente.

Temas reconocidos: `certificado`, `pagos`, `requisitos`, `modalidad`, `grabaciones`, `duracion`, `general`.

Se puede editar en Excel o Google Sheets y guardar como CSV (incluso el formato con punto y coma de Excel en español). Máximo 300 filas por archivo y 300 entradas por marca.

## Cómo cargarlo

1. Administración abre **Catálogo → Conocimiento → Importar preguntas (CSV)**.
2. Sube el archivo (o pega su contenido) y pulsa **Vista previa**: se ve cada fila como *Se creará*, *Ya existe* o *Con errores* y por qué. En este paso no se guarda nada.
3. Pulsa **Importar**. Las filas buenas entran como **borrador**; repetir el archivo no duplica nada.
4. En la pestaña Conocimiento, revisa cada entrada y **apruébala**. Sólo las aprobadas se usan.
5. Prueba en Operación → Seguimientos con el simulador de respuestas antes de encender el modo «Autónomo» en una marca.

## Después de cargar

- Revisa las respuestas que da la IA en el simulador con preguntas reales; si una sale mal, corrige la entrada (vuelve a borrador y se aprueba de nuevo).
- Cuando administración conecte la clave de la IA, el uso del mes se ve en Operación → Seguimientos, junto con el tope de gasto.
