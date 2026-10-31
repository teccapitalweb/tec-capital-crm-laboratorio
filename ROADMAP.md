# De laboratorio a CRM de 15 marcas

## 1. Laboratorio funcional — primera entrega

Perfiles, tres canales simulados, mensajes en tiempo real, adjuntos, flyers de ejemplo, catálogo, reglas por curso, atención humana y persistencia. Validar con al menos siete personas en teléfonos y computadoras. Registrar problemas con hora, usuario de prueba, curso y comportamiento esperado; nunca contraseñas.

Práctica recomendada: cinco clientes y dos asesores. Enviar “Hola”, pedir temario/precio, adjuntar una imagen, solicitar asesor y cerrar el chat. Repetir con los otros canales; actualizar un precio y comprobar que sólo cambian las respuestas futuras.

## 2. Catálogo de las 15 marcas

Base implementada en v0.4: curso separado de edición, fechas y zona horaria, docente, cupos informativos, moneda, vigencia de promoción y enlaces. Biblioteca de flyers propios con aprobación interna, versiones, caducidad e historial; plantillas por escenario y marca con variables y vista previa. El envío bloquea promociones vencidas y material desactualizado y conserva la oferta exacta enviada.

Pendiente de operación: cargar los nombres oficiales y los aproximadamente 120 cursos iniciales con sus fechas, responsables y piezas aprobadas. No inventar información comercial. El catálogo conserva tres marcas y seis cursos de demostración; permite añadir las demás marcas y crea seis plantillas iniciales por marca. Importación masiva, reserva de cupos y editor gráfico de flyers todavía no están incluidos.

## 3. Operación del equipo

Usuarios y permisos por marca, invitaciones individuales caducables, restablecimiento de contraseña, asignación por disponibilidad, notas internas, colas, SLA, deduplicación de contactos, historial buscable, etiquetas, auditoría y exportación. Medir primero volumen real para decidir cuándo migrar a PostgreSQL y una cola externa.

## 4. IA con información vigente

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
