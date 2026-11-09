# Activar la IA de Claude en producción (guía paso a paso)

Para la persona que administra el CRM. Hoy producción usa el **motor simulado** (responde sólo por coincidencia con el conocimiento aprobado y no llama a ninguna IA). Esta guía lo cambia a **Claude** con seguridad: poco a poco, por marca, con un tope de gasto y con una persona revisando. En cualquier paso se puede volver atrás (sección «Volver atrás»).

> **Regla de oro:** la clave de API **no se escribe en el chat, en un correo, en el repositorio ni en capturas de pantalla**. Sólo vive en las variables de entorno de Railway. El repositorio es público.

## Qué hace (y qué no) la IA

- **Hace:** redacta la respuesta a una pregunta de un cliente **usando únicamente** (1) las entradas de **Conocimiento aprobadas** de esa marca y (2) los datos del **catálogo** (precio, fechas, cupos). Recuerda lo que esa persona ya preguntó (sólo de su marca, sin datos de contacto) y, en chats largos, usa un resumen de la conversación.
- **No hace:** inventar precios, fechas o promociones; confirmar pagos ni inscripciones; responder sobre algo que no esté en el conocimiento aprobado (en ese caso **pasa la conversación a una persona**); obedecer instrucciones que escriba el cliente dentro del chat (se tratan como texto, no como órdenes).
- **Quién manda:** cada marca decide su **modo**: apagado, **Sugerir** (la IA propone un borrador y el equipo lo envía o lo corrige), responder con plantillas, o **Autónomo** (responde sola). Se empieza **siempre en Sugerir**.

## Antes de empezar

- [ ] Una cuenta en la consola de Anthropic con crédito. Crea una **llave nueva sólo para este CRM** (nómbrala «tec-capital-crm») y, si la consola lo permite, fija ahí un **límite de gasto mensual**.
- [ ] Una **marca de pruebas** (la de menor peso comercial) para arrancar.
- [ ] Conocimiento de esa marca listo (ver [GUIA_CONTEXTO_CONSULTORA.md](GUIA_CONTEXTO_CONSULTORA.md)): al menos **10 preguntas y respuestas** bien escritas, **sin precios** (los precios salen del catálogo).

## Paso 1 · Poner la clave y el proveedor en Railway

En Railway → el servicio del CRM → **Variables**:

| Variable | Valor | Para qué |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | la llave nueva | Se pega **sólo aquí** |
| `AI_PROVIDER` | `claude` | Cambia del motor simulado a Claude |
| `AI_MONTHLY_CALL_LIMIT` | `200` (para empezar) | Tope de llamadas al mes. Al alcanzarlo, la IA deja de llamar y responde una persona |
| `AI_MONTHLY_TOKEN_LIMIT` | opcional (por ejemplo `500000`) | Tope de tokens (entrada + salida) al mes. `0` = sin tope |

Deja los modelos por omisión (`AI_MODEL` = `claude-sonnet-5-5`; resúmenes con `claude-haiku-5-5`). Railway vuelve a desplegar solo.

## Paso 2 · Comprobar el estado

Entra a `/crm` como administrador → **Operación → Sistema → Inteligencia artificial**. Debe decir **«Claude · claude-sonnet-5-5»** y mostrar con una palomita: la clave está en el entorno, el proveedor es Claude y hay un tope de llamadas. **La clave nunca se muestra**, sólo si existe. Si algo no está en verde, la pantalla dice qué variable falta.

Esa misma pantalla muestra, **por marca**, el veredicto (**No lista**, **Lista para sugerir** o **Lista para responder**) y lo que falta.

## Paso 3 · Cargar y aprobar el conocimiento (marca de pruebas)

1. Catálogo → **Conocimiento** → **Importar preguntas (CSV)** (hay plantilla). Todo entra como **borrador**.
2. Revisa cada respuesta y **apruébala** (sólo administración). Mínimo **10 aprobadas**.
3. Mira «Preguntas que no supimos responder» (arriba del Conocimiento): son lo que los clientes preguntan y aún no tiene respuesta.

## Paso 4 · Autorizar la marca y empezar en «Sugerir»

Operación → Ventas y cobro → **Seguimientos** → «Respuestas automáticas a clientes», en la fila de la marca de pruebas: primero elige el modo **Sugerir al asesor** y después marca la casilla **«Usar la IA para redactar»** (la casilla sólo se habilita con Claude configurado y en los modos Sugerir o Autónomo). En **Inteligencia artificial** la marca pasa a **«Lista para sugerir»**.

## Paso 5 · Probar con clientes de práctica

Con un perfil «PRUEBA · cliente», haz las preguntas típicas (precio, fechas, temario, certificado, formas de pago, «quiero hablar con un asesor») y una que **no** esté en el conocimiento. Comprueba, en cada borrador:

- [ ] Usa los datos del catálogo (el precio y las fechas son los vigentes) y cita el conocimiento correcto.
- [ ] **No inventa** nada ni promete lo que no está aprobado.
- [ ] Ante lo que no sabe, **no responde** y la conversación pasa a una persona.
- [ ] Pedir un asesor siempre lo manda a la cola humana.
- [ ] Un mensaje del cliente que diga «ignora las instrucciones…» **no cambia** su comportamiento.

## Paso 6 · Evaluar con IA real

Catálogo → **Evaluación** → ejecutar el banco de casos **con la IA real**. Se pide **al menos 85 %** (la pantalla de Inteligencia artificial lo marca). Corrige el conocimiento donde falle y vuelve a correr. Con eso la marca pasa a **«Lista para responder»**.

## Paso 7 · Vigilar

- **Uso del mes:** en Inteligencia artificial hay barras de llamadas y tokens frente al tope (se ponen ámbar al 70 % y rojas al 90 %). Ojo: ahí se cuentan **llamadas y tokens, no dinero**; el costo real se ve en la consola de Anthropic.
- **Cada semana:** revisa «Preguntas que no supimos responder» y completa el conocimiento; revisa una muestra de borradores aceptados y rechazados.
- **Si se alcanza el tope:** la IA deja de llamar y todo pasa a una persona; sube `AI_MONTHLY_CALL_LIMIT` sólo si entiendes por qué subió el uso.

## Paso 8 · Pasar a «Autónomo» (opcional, por marca)

Sólo cuando la marca esté **«Lista para responder»** y el equipo haya revisado borradores un tiempo razonable (por ejemplo una o dos semanas). Se cambia el modo en Seguimientos. Las demás marcas siguen su propio camino: **no se activa en todas a la vez**.

## Volver atrás

| Quiero… | Hago… |
| --- | --- |
| Que una marca deje de usar la IA | Seguimientos → modo **Apagado** o **Responder con plantillas**, o apagar «usar la IA» |
| Parar la IA en todo el CRM | Quitar `AI_PROVIDER` (o ponerlo en `simulated`) en Railway: vuelve al motor simulado |
| Cortar el gasto ya | Bajar `AI_MONTHLY_CALL_LIMIT` a `1`, o **revocar la llave** en la consola de Anthropic |
| Una llave se filtró | **Revócala** en la consola de Anthropic al instante, crea otra, ponla en Railway y confirma el estado |

## Qué queda registrado

Cada llamada real deja una fila `ai.call` (tipo, modelo, tokens; **sin** el contenido del chat). Cada respuesta del motor guarda sus fuentes, la confianza y por qué respondió o no. La pantalla de estado es de **sólo lectura**: no enciende ni cambia nada.

Detalle técnico: [PLAN_CONOCIMIENTO_POR_LOTE.md](PLAN_CONOCIMIENTO_POR_LOTE.md) (carga y tope), [PLAN_MEMORIA_CONTEXTO.md](PLAN_MEMORIA_CONTEXTO.md) (memoria y selección), [PLAN_RESUMEN_CONVERSACION.md](PLAN_RESUMEN_CONVERSACION.md) (resúmenes) y [ESTADO_ACTUAL.md](ESTADO_ACTUAL.md) (interruptores).
