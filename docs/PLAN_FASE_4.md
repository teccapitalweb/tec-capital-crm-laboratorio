# Fase 4 propuesta: automatización e IA supervisada

**Estado: pendiente, no implementada.** Este documento convierte el siguiente bloque del [ROADMAP](../ROADMAP.md) en trabajo ejecutable. Documentar este plan no activa campañas, conecta APIs ni autoriza gastos. El usuario pidió el traspaso para que Claude continúe en esta misma computadora.

## Resultado buscado

Que cada marca pueda configurar seguimientos seguros y consultar información aprobada de sus cursos, con una IA que primero ayude al asesor mediante borradores verificables. Los precios, fechas, promociones y cupos se consultan en la base comercial vigente. La IA no confirma pagos, matrículas ni descuentos por su cuenta.

Mantener la experiencia Niebla y los flujos existentes. Construir sobre catálogo, tareas, operación, permisos y snapshots de v0.5; conservar las tres marcas/seis cursos de prueba hasta recibir datos reales.

## Orden de construcción

| Bloque | Entrega | Condición para avanzar |
| --- | --- | --- |
| 4A | Trabajos durables, reintentos acotados, cancelación y registro de fallos | Reinicios y carreras no duplican ni envían una respuesta ya cancelada |
| 4B | Recetas por marca, versiones, simulación y trazas de ejecución | Se puede explicar, pausar y comprobar cada paso sin afectar otros chats |
| 4C | Biblioteca de conocimiento aprobado y recuperación con fuentes | Datos retirados/vencidos o de otra marca no aparecen en respuestas |
| 4D | Copiloto para asesores con límites y evaluación | Borradores útiles, trazables, sin inventar datos comerciales ni ejecutar acciones privilegiadas |
| 4E | Piloto supervisado y automatización limitada, si se autoriza | Métricas aceptadas y parada inmediata; no equivale a integración con Meta |

No iniciar con un constructor visual complejo ni un chatbot que pueda ejecutar todas las acciones. Primero establecer las garantías de ejecución y recuperación que necesitarán ambos.

## 4A. Motor de ejecución durable

El `jobs` actual guarda respuestas por reglas, pero ante una excepción no tiene backoff acotado, estado de fallo terminal o bandeja de recuperación. Corregir ese límite antes de añadir secuencias largas o llamadas a proveedores.

Diseño inicial propuesto —nombres orientativos, todavía no son tablas—:

- `automation_definitions` y `automation_versions`: marca, borrador/publicación/pausa, definición validada, autor y versión inmutable.
- `automation_runs`: evento de origen, conversación/interés, versión usada, estado y causa de cancelación. Un evento no inicia dos veces la misma receta/versionado previsto.
- `automation_steps`: acción, orden, `scheduled_at`, intentos, `next_attempt_at`, lease y vencimiento, resultado, error saneado y clave idempotente.
- `automation_events`: transiciones y explicación de decisiones, con marca, actor/worker y hora.
- Configuración por marca: habilitación, límites de frecuencia y pausa global. El primer despliegue deja todo desactivado.

Definir estados explícitos como pendiente, reservado, completado, cancelado y fallido. Un lease expirado permite recuperar un paso después de caída del proceso. Separar errores transitorios de validación/permiso; aplicar backoff con límite de intentos, visibilidad del fallo y reintento manual controlado.

Las llamadas al proveedor van **fuera** de la transacción SQLite: reservar trabajo brevemente, llamar con timeout y persistir resultado tras revalidar estado. No mantener la DB bloqueada durante una respuesta de IA. Cuando exista un canal externo, considerar resultado ambiguo del proveedor y su identificador/idempotencia; reintentar ciegamente puede duplicar un mensaje aunque la DB local sea correcta.

Para mensajes del laboratorio, usar una transacción que revalide elegibilidad y guarde el efecto/resultado idempotente juntos. Conservar referencias y snapshots del catálogo. No duplicar los caminos de autorización o inserción ya comprobados.

### Cancelaciones y precedencia

Cada receta declara qué la cancela. Debe comprobarse al programar **y justo antes del efecto**:

- El cliente respondió y el seguimiento por silencio ya no aplica.
- Un asesor tomó el control, pausó la automatización o transfirió a un estado incompatible.
- Se cerró la conversación/interés, se suspendió el usuario o cambió el alcance permitido.
- El curso/edición/material se archivó o la promoción/plantilla ya no es válida.
- El contacto solicitó baja o revocó consentimiento cuando se incorpore ese flujo.

La baja/consentimiento aún no existe: si se implementan seguimientos proactivos, añadir primero un estado explícito y comprobable, no simular cumplimiento con una etiqueta visual. Para el laboratorio, limitarse a perfiles de prueba y mensajes dentro de él.

Una cancelación que compite con el envío debe resolverse con estado/revisión e idempotencia en el servidor. Una marca de “cancelado” en la UI no detiene por sí sola un worker.

## 4B. Recetas editables y explicables

Primera interfaz: lista de recetas por marca, formulario de pasos, borrador/publicada/pausada, versiones, simulación y lista de ejecuciones. Mantener un conjunto limitado de activadores, condiciones y acciones; no aceptar JavaScript arbitrario ni `eval`.

Activadores candidatos: solicitud inicial de información, solicitud de inscripción, petición de asesor, tiempo sin respuesta y tarea vencida. Empezar con uno o dos que puedan probarse bien. Condiciones: marca, curso/edición, etapa, responsable, modo humano/reglas, horario y última actividad.

Acciones reutilizables: enviar material aprobado, crear tarea, añadir nota, solicitar atención o avanzar una etapa permitida. La asignación usa la política operativa actual; no salta capacidad/permisos. Una receta no gana oportunidades ni valida comprobantes.

Las macros actuales son acciones manuales con transacción y preview. Pueden aportar validadores/acciones, pero no sustituyen programación, leases, cancelación ni un motor de recetas. No acoples su interfaz de “aplicar ahora” a un seguimiento diferido sin modelar esas diferencias.

La simulación muestra: entrada usada, condiciones evaluadas, datos/versión de catálogo, acciones propuestas, horario previsto y motivo para omitir un paso. Debe ser una operación sin envíos, notas, tareas ni cambios comerciales. Publicar una nueva versión no reescribe la definición de ejecuciones ya iniciadas; decidir y documentar si se cancelan o continúan con su versión original.

## 4C. Información vigente y RAG

RAG significa recuperar fragmentos de información antes de generar una respuesta. Es una ayuda para consultar documentos, **no reemplaza** el catálogo estructurado.

| Dato | Fuente autorizada |
| --- | --- |
| Precio, promoción activa, fechas, modalidad, moneda y cupo | Consulta a las tablas de curso/edición/promoción al preparar y enviar |
| Oferta compartida anteriormente | Snapshot del mensaje/oportunidad, identificado como histórico |
| Temario extenso, preguntas frecuentes, políticas y requisitos | Documentos aprobados y versionados con alcance y vigencia |
| Identidad, permisos, responsable y estado | Base de identidad/CRM actual |
| Pago o inscripción confirmados | Futuro sistema autorizado; hoy no existe esa confirmación |

Modelar documento, versión, fragmento y estado de indexación con marca, curso/edición opcionales, idioma, autor/aprobador, fecha de actualización, vigencia, origen y checksum. Al publicar una versión nueva o archivar la anterior, invalidar sus fragmentos/caché de forma verificable. Conservar trazabilidad de qué versión se usó en cada respuesta.

Filtrar permisos y vigencia **antes** de recuperar contexto; volver a validar antes de usarlo. No buscar globalmente y pedirle al modelo que ignore otras marcas. Los documentos son datos, no instrucciones con autoridad para cambiar permisos o revelar secretos.

Para el volumen inicial puede bastar búsqueda de texto con ranking y referencias. Elegir embeddings/vector store cuando una evaluación demuestre que mejora recuperación. Si se usa índice externo, prever eliminación/actualización, acceso por marca, costo y consistencia con SQL. No crear infraestructura adicional sólo por llamar al módulo “RAG”.

Pruebas mínimas: consulta correcta, información ausente, dos documentos contradictorios, promoción vencida, edición distinta, documento archivado, actualización durante generación, pregunta de otra marca e instrucciones maliciosas dentro de un PDF o mensaje.

## 4D. Copiloto de IA

Primero un panel que sugiera una respuesta y muestre fuentes, fecha de consulta y cualquier dato faltante. El asesor revisa/edita y envía. Registrar que el texto fue sugerido por IA y si se modificó, sin almacenar secretos o razonamiento interno del modelo.

Herramientas permitidas inicialmente: consultar catálogo, recuperar conocimiento aprobado y preparar un borrador. Acciones de escritura o envío deben pasar por los mismos validadores y permisos de la aplicación; un texto del cliente o documento no puede conceder esos permisos.

Separar contexto por marca/curso/edición, limitar historial enviado y sanear contenido innecesario. Resumir conversaciones sin convertir el resumen en fuente de precios. Si faltan datos o hay discrepancia, preguntar/derivar en vez de inventar. No prometer acreditación, validez de certificados, reembolso, cupo reservado o pago confirmado sin fuente autorizada.

Proveedor, modelo y presupuesto **no están elegidos ni configurados**. Al implementarlo, verificar documentación oficial vigente, contrato de datos, retención y capacidades. Las claves van sólo al servidor/gestor de secretos. Prever timeout, límite de tokens/gasto por marca, concurrencia, contadores de consumo y modo desactivado cuando falte configuración. No poner nombres de modelos o precios recordados como requisito fijo.

Las fuentes se muestran como citas/referencias de producto; los detalles técnicos del worker permanecen en una vista de diagnóstico, no en la conversación del cliente.

## 4E. Piloto y criterios de salida

Primero una marca y dos cursos de prueba, con personas del equipo. Conservar el laboratorio de canales simulados para ensayar; ninguna de estas entregas conecta WhatsApp, Instagram o Facebook reales.

| Criterio | Evidencia esperada |
| --- | --- |
| Reintento seguro | Repetir evento/paso/petición no duplica mensaje, tarea o nota |
| Reinicio | Un paso reservado se recupera o cancela correctamente; sin saltar efectos |
| Carrera de cancelación | Respuesta del cliente/toma humana/cierre impiden el envío pendiente |
| Revisión comercial | Precio/promoción/material cambiantes producen nueva preparación o cancelación |
| Permisos | Revocar una marca impide consulta, generación y envío aunque existiera un trabajo pendiente |
| Fallos | Timeout/proveedor caído genera reintentos limitados y un fallo visible/reanudable |
| Simulación | No produce efectos en datos comerciales ni mensajes |
| Conocimiento | Fuente/versionado rastreable; documento retirado no reaparece por caché |
| IA | No inventa precio/fecha/pago; resiste peticiones de extraer datos de otras marcas o ignorar reglas |
| Costos y control | Contadores y límites; pausa por marca y global comprobada |
| Experiencia | Asesor distingue borrador, envío y fallo; edición preservada y revisión móvil |

Medir resultados con un conjunto de preguntas y respuestas esperadas, revisado por responsables del curso. Definir umbrales aceptables con el equipo antes de activar autonomía. No vender un porcentaje de exactitud sin conjunto de evaluación y evidencia reproducible.

## Primera sesión de Claude sugerida

1. Leer la continuidad y comprobar repo/versiones; confirmar el alcance del nuevo pedido del usuario.
2. Ejecutar pruebas de referencia y revisar worker, toma humana, idempotencia y catálogo.
3. Diseñar el primer cambio 4A, con migración nueva, estados y política de cancelación explícita; registrar decisiones en documentación.
4. Implementar una receta mínima en modo simulación/desactivado y pruebas de fallos/carreras. No introducir proveedor de IA todavía si no están resueltos esos controles.
5. Revisar localmente con el usuario. Publicar sólo cuando corresponda al pedido activo; la solicitud de documentar no es una orden de comenzar automáticamente toda la fase 4.

## Dependencias del usuario para etapas posteriores

Nombres y responsables reales de las 15 marcas; cursos/ediciones/promociones vigentes; políticas/temarios aprobados; horarios y límites de operación; proveedor y presupuesto de IA; reglas de consentimiento/retención; y, para Meta, activos/números y permisos. Puede avanzarse en motor y simulación con los datos ficticios mientras se reúne esa información.
