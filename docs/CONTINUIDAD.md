# Estado del proyecto y decisiones

Documento de entrega para continuar el CRM sin depender del historial del chat. Corte: **30 de octubre de 2026, America/Mexico_City**; el despliegue de referencia ocurrió el 31 de octubre en UTC.

## Producto y alcance acordado

TEC Capital opera varias consultoras que son marcas de su misma empresa. El objetivo es administrar conversaciones y ventas de cursos de unas 15 marcas, con ocho o más cursos por marca. El laboratorio permite practicar con siete personas o más; no tiene un cupo funcional fijo de siete cuentas, aunque su capacidad comercial todavía necesita medirse.

Cada participante crea un perfil con nombre, usuario, contraseña e identificador de prueba. No necesita su número de WhatsApp. El cliente elige curso, edición y canal simulado y conversa en tiempo real con el equipo. Los asesores pueden trabajar sólo con sus marcas; administración tiene alcance general.

El sitio ya está en Railway. Publicar el código en GitHub no reemplaza el servidor ni la persistencia. Este proyecto no funciona como aplicación completa en GitHub Pages.

La intención futura es conectar WhatsApp, Instagram y Messenger oficiales, responder con plantillas, compartir flyers y usar IA con información comercial vigente. **Ninguna conexión de Meta ni IA está habilitada actualmente.** No conviertas un WhatsApp personal ni migres números como parte de este traspaso documental.

## Identificación de la versión publicada

| Dato | Referencia verificada |
| --- | --- |
| Aplicación | `0.5.0` |
| Commit funcional | `c7218f15d346e08406a96786db68523e78db4877` |
| Esquema esperado | `PRAGMA user_version = 6` |
| Rama remota | `main` |
| Railway deployment | `df2ce476-2341-4811-a95d-85debc17636b`, `SUCCESS` |
| Health | `ok: true`, `version: 0.5.0`, `transport: websocket`, `mode: laboratorio` |
| CI | [Ejecución 41152821918](https://github.com/teccapitalweb/tec-capital-crm-laboratorio/actions/runs/41152821918), correcta |
| Pruebas automáticas | 57 aprobadas, 0 fallidas |

Este commit identifica el código funcional. Un commit posterior que añada únicamente esta documentación no implica una versión funcional diferente.

## Entregas completadas

| Entrega | Commit | Resultado |
| --- | --- | --- |
| Base comercial v0.2 | `cab6e14` | Mi día, contactos, oportunidades, tareas, notas, configuración, permisos por marca, invitaciones y recuperación asistida |
| Primera fase de consolidación v0.3 | `31820df` | Tres regresiones comerciales corregidas, tareas editables, búsqueda de históricos, historial y control de concurrencia |
| Segunda fase v0.4 | `7b19322` | Catálogo por edición, promociones, biblioteca aprobada de flyers/plantillas, oferta y archivo históricos |
| Tercera fase v0.5 | `c7218f1` | Cola, reparto, horarios, capacidad, transferencias, menciones, avisos, objetivos de respuesta y macros |

### Consolidación comercial

- Todas las vistas comerciales consultan la etapa de la oportunidad.
- Preguntar un precio no hace retroceder una inscripción solicitada.
- Las reglas no reabren oportunidades cerradas ni confirman ventas.
- Reabrir un interés cuando ya existe otro activo de ese contacto/curso/edición devuelve un conflicto y permite localizar el vigente.
- Tareas con título, fecha, dueño, estado y motivo de cambio; cancelar, completar, reabrir y reprogramar.
- Búsqueda por persona, número de prueba, marca, curso, edición y texto del historial. La búsqueda no se limita al resumen de 300 conversaciones del bootstrap.

### Catálogo y biblioteca

- Curso general separado de sus ediciones. Fechas, zona horaria, docente, modalidad, lugar, enlace, cupos, moneda y precio por edición.
- Promoción con precio y vigencia propios. Control de solapamiento, precio menor al regular y final anterior o igual al inicio de la edición.
- PNG, JPG, WebP, GIF y PDF de hasta 4 MB; borrador, aprobación interna, archivo, caducidad y versión.
- Variables en plantillas; alcance por marca/curso/edición/canal; flyer opcional; vista previa antes del envío.
- Los seis flyers de demostración se importaron cuando seguían coincidiendo con el catálogo. Cada marca nueva recibe seis plantillas de ejemplo.
- Cambiar datos comerciales invalida la correspondencia de un flyer estático. La imagen no se corrige por OCR: la persona que aprueba debe revisarla.
- Los mensajes conservan el precio, texto, edición y archivo exactos que se compartieron. Los archivos reemplazados permanecen disponibles para su historial.
- El cupo es informativo; no se reserva ni descuenta al cambiar una etapa.

### Operación del equipo

- Cola de atención humana por prioridad, espera, marca y responsable; páginas de 50.
- Reparto por menor carga entre integrantes configurados, conectados, disponibles, autorizados y con capacidad. El desempate considera asignaciones previas y el identificador.
- Límite inicial de ocho chats abiertos por integrante, entre todas sus marcas; administración puede ajustarlo.
- Horarios por marca y zona IANA. Objetivos de primera/siguiente respuesta en minutos hábiles. No se cuenta una lectura o respuesta automática como respuesta humana.
- Transferencias con contexto y aceptación/rechazo/cancelación; vencen a las 24 horas. Los chats abiertos y tareas de una oportunidad se trasladan juntos.
- Notas internas con menciones y avisos persistentes. Los clientes no tienen acceso a estos contenidos.
- Macros manuales que combinan plantilla, avance comercial, tarea y nota; versiones, vista previa y ejecución idempotente en una transacción.
- Historial operativo y versiones de configuración. Los borradores de configuración en edición se protegen frente a actualizaciones en vivo.

El reparto y los objetivos de atención se entregaron **desactivados por defecto**. La prueba publicada no cambió la política de las marcas existentes. Verificar el estado actual antes de activar o modificar algo: el equipo puede haberlo configurado después.

## Decisiones de experiencia

La dirección visual elegida por el usuario es **Niebla**: blanco y gris, transparencias suaves, sombras discretas, contornos finos y colores de canal puntuales. Evitar saturar la interfaz con tarjetas de colores. Mantener legibles los distintivos WhatsApp/Instagram/Facebook.

El puesto del vendedor debe indicar qué atender, quién es responsable y cuál es el siguiente paso. Priorizar acciones útiles y vistas compactas. Revisar tanto teléfono como escritorio; no introducir desplazamiento horizontal accidental en formularios o modales.

Todo texto operativo está en español. La simulación debe seguir siendo explícita: “Ganada · prueba” no confirma dinero, inscripción ni entrega de acceso.

## Evidencia de v0.5

Las 57 pruebas de Node cubren mensajería de siete clientes, persistencia, accesos, archivos, catálogo, concurrencia, historial, reparto y macros. CI ejecutó la misma suite en Linux con Node 24.

La revisión local en Edge/Playwright completó configuración de horario/capacidad, cola, nota con mención, transferencia entre dos asesores, creación y aplicación de macro y lectura del cliente. Se revisaron escritorio y ancho móvil de 390 px, sin errores de JavaScript en ese recorrido. Se comprobó que una actualización en vivo no borra el formulario de horario en edición.

En la web publicada se comprobó:

- Bundle público coincidente con el código local.
- Entrada autenticada de administración, dos asesores y un cliente de prueba.
- Solicitud de asesor, toma, nota privada, aviso y transferencia aceptada.
- Vista previa/aplicación de macro, reintento sin duplicados, tarea asignada y mensaje al cliente en tiempo real.
- Registro de respuesta humana, historial y aislamiento de marca/cliente.
- Vista móvil y conservación de la configuración existente.

Al terminar, se pausó la macro técnica, se cerraron oportunidad/chat/tareas y se suspendieron las dos cuentas técnicas de asesor retirando sus marcas. Los registros históricos de QA permanecen deliberadamente; no son ventas ni actividad de clientes reales. Las pruebas no certifican carga comercial, seguridad completa o recuperación de producción.

## Avance local posterior a v0.5: bloques 4A y 4B (31 oct 2026)

Sin publicar ni desplegar; los cambios están en el árbol de trabajo, sin confirmar en Git. Añade el esquema v7 y el motor de pasos durables descrito en [PLAN_FASE_4.md](PLAN_FASE_4.md#4a-implementado-local-31-oct-2026). `package.json` sigue en `0.5.0`: sube la versión al publicar. Verificación local: `npm run check` y `npm test` con 79 pruebas aprobadas (dos ejecuciones completas seguidas tras añadir 4B; 69 con sólo 4A). En una ejecución anterior falló una vez la prueba de catálogo «vencimientos y material programado…» (espera fija de 1,2 s al trabajo de reglas, en paralelo con el resto de la suite) y no se reprodujo en 6 repeticiones; probable sensibilidad de tiempo bajo carga, no diagnosticada. 4B añade recetas de seguimiento por silencio (esquema v8, ver PLAN_FASE_4); sin interfaz todavía. Tres pruebas existentes se actualizaron de `user_version` 6 a 8. No hay cambios de interfaz, así que no se revisó navegador; tampoco se probó contra Railway.

### Corrección visual: ancho completo en pantallas grandes (31 oct 2026)

El usuario reportó franjas vacías a ambos lados del CRM en su monitor (~1890 px de ancho). Diagnóstico: `.workspace` tenía `max-width:1800px` centrado con bordes laterales, por lo que cualquier ventana mayor de 1800 px dejaba (ancho − 1800)/2 px libres por lado. Se quitó el límite y los bordes en `public/styles.css`. Verificado en navegador emulando 1900 px: el contenedor ocupa 1900 px, sin margen ni desplazamiento horizontal; las 79 pruebas siguen pasando. No se revisó de nuevo móvil ni tableta (el cambio sólo actúa por encima de 1800 px). **Sólo local:** el sitio publicado conserva las franjas hasta el próximo despliegue. Otros límites de ancho existentes (`.entry` 1320 px en el acceso y los de contenido de CRM/catálogo) no se tocaron.

## Pendientes reales

1. **Fase 4:** 4A y primera entrega de 4B hechos localmente (motor durable y recetas por silencio, API sin interfaz, sin publicar); faltan interfaz y más disparadores de 4B, conocimiento aprobado, evaluación y copiloto. Ver [plan detallado](PLAN_FASE_4.md).
2. **Canales oficiales:** activos de Meta, permisos, webhooks, estados del proveedor y políticas/ventanas vigentes, a verificar al implementar.
3. **Venta real:** pedido, pago, conciliación, matrícula y acceso conectados con los sistemas autorizados.
4. **Catálogo comercial:** las marcas/cursos/fechas reales, sus responsables y piezas aprobadas todavía deben cargarse y validarse.
5. **Operación ampliada:** festivos y turnos personales, etiquetas, deduplicación/fusión de contactos, exportación, supervisores y permisos más detallados.
6. **Antes de clientes reales:** MFA, recuperación de administración, retención, consentimiento, cuotas, observabilidad, respaldo periódico con adjuntos y restauración ensayada.

Los documentos de auditoría antiguos contienen diagnósticos anteriores a estas entregas. Sirven para entender el plan, pero sus listas de carencias no son el inventario actual.
