# Constructor de flujos de bienvenida (12 nov 2026)

Rama `feat/flujo-bienvenida`. **Esquema 40.** Sin publicar.

## Para qué

Hasta ahora el asistente sólo respondía a lo que le preguntaban. Con el flujo de bienvenida, cada marca arma **sin código** el recorrido guiado que recibe quien escribe por primera vez: un saludo y un menú con botones que lo llevan al temario, al precio, a las fechas o a inscribirse. Es lo que más se nota en una presentación y lo que más ayuda a que la marca venda sola.

Está **apagado por omisión** en todas las marcas.

## Cómo se arma

**Operación → Ventas y cobro → Flujo de bienvenida** (sólo administración).

- Se elige la marca y se editan sus **pasos**. Cada paso es un mensaje con hasta **tres botones** (el límite de WhatsApp).
- Cada botón hace una de dos cosas:
  - **El asistente responde**: precio vigente, temario, fechas y horario, inscribirse, o pasar con una persona.
  - **Lleva a otro paso**: para tener más de tres opciones.
- En los mensajes se usan los datos por su nombre: `{{nombre}}`, `{{curso}}`, `{{edicion}}`, `{{marca}}`.
- Dos casillas: **enviar la ficha del curso con el saludo** y **flujo encendido**.
- A la derecha, una **vista previa tipo teléfono**: se pulsan los botones y se recorre el flujo como lo vería la persona. No se envía nada.
- Lo escrito vive en un borrador hasta pulsar **Guardar flujo**; agregar o quitar pasos no pierde lo tecleado. La pantalla no se refresca sola mientras se edita.
- Cada marca empieza con un flujo sugerido de dos pasos (Precio · Temario · Más opciones → Fechas y horario · Inscribirme · Hablar con asesor).

## Cómo se comporta

El flujo **no sustituye** al motor de respuestas; decide el saludo y el menú. Funciona cuando la marca responde sola («Plantillas» o «Autónomo»).

| Situación | Qué pasa |
| --- | --- |
| Saludo o primer mensaje sin pregunta | Sale el paso 1 con sus botones (y la ficha del curso, si está marcada) |
| Su primer mensaje es una pregunta concreta («¿cuánto cuesta?») | Se contesta como siempre y se le ofrece el menú del paso 1 |
| Pulsa un botón que lleva a otro paso | Sale ese paso con sus botones |
| Pulsa un botón de «el asistente responde» | Responde por el camino de siempre (precio y fechas salen del catálogo vigente) y **el menú sigue a la vista** |
| Pulsa «Inscribirme» o «Hablar con asesor» | Igual que si lo pidiera con sus palabras; el recorrido termina y la respuesta ya no ofrece el menú |
| Escribe cualquier otra cosa | Contesta el asistente de siempre (reglas → conocimiento → IA). El menú sigue valiendo una vez más; al segundo mensaje seguido que no es un botón, el recorrido termina (así un «sí» escrito más tarde no se confunde con un botón) |
| La edición no está disponible | Manda el aviso de siempre y pasa a una persona, aunque pulsen un botón |
| Pide la baja | Se confirma la baja, sin menú |
| Una persona del equipo toma el chat | El asistente deja de responder, como siempre |

- Un botón se reconoce por su texto, sin importar mayúsculas, acentos ni signos. Así funciona igual en el chat de prueba (botón tocable) y en WhatsApp real (botón de respuesta).
- El paso en el que va cada conversación se recuerda **24 horas**.
- **Guardar** un flujo reinicia los recorridos a medias de esa marca: su siguiente mensaje lo atiende el motor de siempre.

## Datos (esquema 40)

- `welcome_flows(brand_id, enabled, with_flyer, steps, revision, updated_by, updated_at)`: un flujo por marca; `steps` es JSON validado por `server/flows.mjs`.
- `flow_runs(conversation_id, step_id, misses, updated_at)`: en qué paso va cada conversación y cuántos mensajes seguidos no fueron un botón.

Límites: 10 pasos, 3 botones por paso, 20 caracteres por botón, 900 por mensaje.

## Dónde vive

- `server/flows.mjs`: validación (`cleanSteps`), datos por nombre (`render`), comparación de botones (`norm`), `active`, `pressed`, `apply` y las rutas `GET /api/flows` (equipo, sus marcas) y `PUT /api/flows/<marca>` (administración, con `expectedRevision`).
- `server/replies.mjs`: `plan()` consulta el flujo; un botón de acción se convierte en la intención correspondiente y sigue el camino de siempre; `commit()` guarda el paso.
- `server/channel.mjs`: los botones de un flujo se guardan aunque la marca no simule el canal (`keep`).
- `server/connectors.mjs`: en WhatsApp real, un saludo con ficha **y** botones sale como imagen y, aparte, el mensaje con sus botones (antes los botones se perdían si había imagen).
- `public/flows.js` y estilos `.fl-*` en `public/operations.css`.

## Cuidados

- **Datos comerciales**: el flujo nunca escribe precios ni fechas; sus botones piden al asistente la respuesta, que sale del catálogo al momento.
- **Sin datos de contacto** en los mensajes: sólo nombre, curso, edición y marca.
- **Sin duplicados ni estados a medias**: el paso se guarda en la misma transacción que la respuesta.
- **Dos personas editando a la vez**: el constructor guarda sobre la revisión con la que empezó; si alguien más guardó entretanto, avisa en lugar de pisar su trabajo.
- **Alcance por marca**: cada flujo es de su marca; el equipo sólo ve los de sus marcas y sólo administración los cambia.
- También se corrigió, de paso, que los formularios de WhatsApp en Conectores (asignar número, nueva plantilla) se podían borrar al refrescarse la pantalla mientras se escribía.

## Límites

- Un solo flujo por marca (no por curso ni por canal).
- El recorrido es un menú: no hace preguntas abiertas ni guarda respuestas («¿de qué ciudad eres?»).
- Sin estadísticas por botón todavía.
- La lista de pasos es un editor por tarjetas, no un lienzo con flechas.
- En WhatsApp real no se ha probado con Meta de verdad (sí con la API simulada).

## Verificación

- `test/flows.test.mjs` (3 pruebas): validaciones y datos por nombre; formato en WhatsApp real de un saludo con ficha y botones; y el recorrido completo en el laboratorio (apagado por omisión, permisos, saludo con nombre, ficha y botones, navegación, acción con menú a la vista, texto libre, inscribirse y asesor terminan, primera pregunta concreta, baja, flujo propio sin ficha, guardar reinicia, apagar).
- Suite completa: 207 pruebas.
- Revisión independiente del código: sin fallos graves. Se corrigieron dos importantes (dos administradores editando a la vez podían pisarse; al pasar a una persona en el primer mensaje, la respuesta todavía ofrecía el menú) y tres menores (un recorrido viejo confundía texto normal con un botón; un botón de paso se saltaba el aviso de edición no disponible; un cuerpo vacío daba error 500).
- En el navegador con la base de demostración: armar, recorrer la vista previa, guardar y encender; y el chat del cliente a tamaño de celular con la ficha y los botones (40 px de alto, sin desbordes).

## Pendiente

1. Verlo en producción con una marca de prueba.
2. Estadísticas: cuántas personas pulsan cada botón.
3. Un flujo por curso o por canal, y preguntas que guarden la respuesta.
