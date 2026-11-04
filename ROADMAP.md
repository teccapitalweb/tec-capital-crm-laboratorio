# De laboratorio a CRM de 15 marcas

**Estado real al 4 nov 2026** (el detalle vigente está en [docs/ESTADO_ACTUAL.md](docs/ESTADO_ACTUAL.md)):

| Fase | Estado |
| --- | --- |
| 1. Laboratorio funcional | Hecha y ampliada: canales simulados con estados de entrega, simulador de clientes, modo presentación |
| 2. Catálogo de las 15 marcas | Base hecha (cursos, ediciones, promociones, biblioteca, importación CSV). **Falta cargar** las marcas y los ~120 cursos oficiales |
| 3. Operación del equipo | Hecha (v0.5) y ampliada: coordinación académica, certificados, finanzas, persona única, campañas y portal por roles |
| 4. Automatización e IA supervisada | Motor durable, recetas, respuestas v2, conocimiento aprobado y banco de evaluación hechos. **Falta probar la IA real** con clave en un entorno aislado |
| 5. Canales oficiales de Meta | Contrato de conectores y canal simulado hechos. **Faltan accesos** de las consultoras |
| 6. Inscripciones y pagos | Pedido, pago simulado, inscripción, pagos por sesión, libro y comisiones hechos. **Falta la pasarela real** y la base única (núcleo Postgres, hoy outbox simulado) |
| 7. Piloto comercial | **Pendiente**: requiere catálogo oficial, accesos, verificación autenticada en producción ([runbook](docs/ACTIVACION_Y_VERIFICACION.md)) y respaldos ensayados |

Las secciones de abajo son el plan original y se conservan como referencia.

## 1. Laboratorio funcional — primera entrega

Perfiles, tres canales simulados, mensajes en tiempo real, adjuntos, flyers de ejemplo, catálogo, reglas por curso, atención humana y persistencia. Validar con al menos siete personas en teléfonos y computadoras. Registrar problemas con hora, usuario de prueba, curso y comportamiento esperado; nunca contraseñas.

Práctica recomendada: cinco clientes y dos asesores. Enviar “Hola”, pedir temario/precio, adjuntar una imagen, solicitar asesor y cerrar el chat. Repetir con los otros canales; actualizar un precio y comprobar que sólo cambian las respuestas futuras.

## 2. Catálogo de las 15 marcas

Base implementada en v0.4: curso separado de edición, fechas y zona horaria, docente, cupos informativos, moneda, vigencia de promoción y enlaces. Biblioteca de flyers propios con aprobación interna, versiones, caducidad e historial; plantillas por escenario y marca con variables y vista previa. El envío bloquea promociones vencidas y material desactualizado y conserva la oferta exacta enviada.

Pendiente de operación: cargar los nombres oficiales y los aproximadamente 120 cursos iniciales con sus fechas, responsables y piezas aprobadas. No inventar información comercial. El catálogo conserva tres marcas y seis cursos de demostración; permite añadir las demás marcas y crea seis plantillas iniciales por marca. Importación masiva, reserva de cupos y editor gráfico de flyers todavía no están incluidos.

## 3. Operación del equipo

Implementado en v0.5 siguiendo la tercera entrega de la revisión competitiva: cola priorizada y paginada, reparto por marca/carga/disponibilidad/presencia/horarios, límites globales, transferencias con contexto y aceptación, notas con menciones privadas, avisos persistentes y objetivos de primera/siguiente respuesta humana. Macros manuales versionadas con vista previa, acciones atómicas e historial. Conserva usuarios, permisos, invitaciones, recuperación y tareas de entregas anteriores.

Por configurar por el equipo: horarios oficiales, responsables, límites de carga, integrantes de reparto y plazos de atención de cada marca. El reparto y los objetivos se publican desactivados. Festivos, turnos personales, etiquetas, fusión de contactos, exportación operativa y roles especializados siguen en el backlog; no forman parte del bloque de coordinación de v0.5. Medir el volumen real antes de cambiar a PostgreSQL y una cola externa.

## 4. Automatización e IA supervisada

Plan de implementación, dependencias y criterios de aceptación: [docs/PLAN_FASE_4.md](docs/PLAN_FASE_4.md). Esta fase sigue pendiente; el traspaso documental no la activa.

Siguiente entrega del plan: recetas de seguimiento versionadas y simulables, activadores, condiciones, cancelación por respuesta/intervención/cierre/baja, reintentos y trazas de ejecución. Reutilizar las reglas de reparto y acciones manuales ya probadas. Las macros de v0.5 se aplican por decisión del asesor; no son campañas ni secuencias automáticas.

Precios, fechas, cupos y promociones se consultan en la base estructurada en cada respuesta: no se confían a la memoria del modelo. RAG recupera temarios, políticas y preguntas frecuentes de documentos aprobados, siempre filtrados por marca, curso, edición y vigencia. Versionar documentos e índice; invalidar contenido obsoleto al publicar cambios.

La IA debe mostrar al asesor sus fuentes y fecha de actualización. Si faltan datos, hay conflicto o se solicita un reembolso/pago, deriva al equipo. Empezar sugiriendo borradores; activar respuestas automáticas sólo tras evaluar casos reales anonimizados. Límites de gasto, registro de herramientas, evaluación contra invenciones y protección contra instrucciones maliciosas en mensajes/documentos. Nunca confirmar pagos con una imagen de comprobante.

## 5. Canales oficiales de Meta

Definir propiedad de números y activos por marca, permisos y verificación comercial. Implementar adaptadores independientes para WhatsApp Business Platform, Messenger e Instagram, webhooks verificados, deduplicación y reintentos. Revisar en ese momento requisitos, ventanas de mensajería, plantillas, consentimiento, precios y políticas vigentes de cada API. La aplicación de laboratorio no sustituye estas integraciones ni garantiza su aprobación.

## 6. Inscripciones y pagos

Conectar el sistema autorizado de cursos/inscripciones. Crear referencias por interesado y edición; validar pagos con eventos firmados del proveedor y controles de idempotencia. Separar solicitud, pago confirmado, inscripción y entrega de acceso. Probar anulaciones y conciliación antes de habilitar operación real.

## 7. Piloto comercial y expansión

Primero una marca y uno o dos cursos con supervisión humana. Medir mensajes perdidos/duplicados, latencia, resolución, respuestas incorrectas, conversiones y costo por conversación. Ensayar restauración de respaldos y recuperación del servicio. Expandir a tres marcas y luego a quince cuando existan responsables, catálogo vigente y resultados verificados.

## Requisitos para cada salto

- Laboratorio → IA: fuentes autorizadas, casos de evaluación y presupuesto definido.
- Laboratorio → clientes reales: permisos, cuentas recuperables, retención y respaldos probados.
- Simulación → Meta: activos y permisos disponibles, webhooks validados y plantillas aprobadas cuando correspondan.
- Una marca → quince: separación de datos/contexto, responsables del catálogo, métricas y monitoreo.

La base diseñada para el laboratorio demuestra los flujos e incluye permisos por marca. Antes de operación comercial siguen siendo necesarios respaldos y restauración ensayados, retención, observabilidad, pruebas de carga y revisión de seguridad de las integraciones reales.
