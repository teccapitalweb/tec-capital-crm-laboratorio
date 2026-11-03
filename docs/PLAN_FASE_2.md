# Plan de la Fase 2: núcleo único e integración con lo existente

Escrito el 2 nov 2026 al cerrar la Fase 1 (v0.20.0, siete bloques publicados). Desarrolla el apartado «Fase 2» de [VISION_PLATAFORMA.md](VISION_PLATAFORMA.md) en bloques ejecutables con el mismo método de la Fase 1: una rama por bloque, migración aditiva, pruebas, revisión en navegador, documentación y publicación sólo por instrucción expresa. Todo lo nuevo nace **apagado por marca** o sin efecto hasta que administración lo use.

## 0. Punto de partida y principio rector

- El CRM ya cubre la venta de punta a punta en simulación: canal, motor de respuestas con conocimiento aprobado, recetas, pago simulado con comprobantes, inscripción, modo presentación, contrato de conectores y banco de evaluación. Esquema SQLite 18, 131 pruebas.
- La Fase 2 convierte el CRM en el **módulo de ventas de una plataforma** con un núcleo de datos compartido (persona, consultora, curso, edición/cohorte, conversación, oportunidad, pago, inscripción, certificado, comisión, evento) y añade los módulos que hoy viven en el panel IPCIL y en la Academia: coordinación académica, certificación y finanzas.
- **Principio:** primero el núcleo *lógico* (eventos, identidad, módulos) dentro de la aplicación actual, donde no dependemos de nadie; la base única en Postgres/Supabase se aborda cuando exista la decisión y el acceso, con una ruta de migración que no obliga a reescribir. Esto respeta la regla del repositorio de continuar la aplicación actual sin emprender una reescritura como requisito para avanzar.

## 1. Bloques propuestos (en el orden recomendado)

| # | Bloque | Depende de | Tamaño | Valor visible en la presentación |
| --- | --- | --- | --- | --- |
| 2.1 | Eventos de dominio (la columna vertebral) | nada | S | Bitácora única de hechos del negocio |
| 2.2 | Identidad única de persona | 2.1 | M | Un cliente, varias marcas, un historial |
| 2.3 | Coordinación académica: aperturas, sesiones, inscritos | 2.1 | L | La venta entra sola a la apertura |
| 2.4 | Finanzas: libro de ventas, comisiones, exportación | 2.1 | M | Lo que la contadora pide hoy en Excel |
| 2.5 | Certificación: emisor único con folio y verificación | 2.3 | M | Certificado verificable al cerrar la apertura |
| 2.6 | Contenido: roles, plantillas por evento, fichas, variantes asistidas | 2.1, 2.3 | M | Mensajes del ciclo completo sin escribirlos |
| 2.7 | Núcleo Postgres/Supabase y ruta de migración | decisión 7.1, acceso | L | Una sola base para CRM, Academia e IPCIL nuevo |
| 2.8 | Puente con IPCIL (históricos y roles) | IPCIL nuevo | S | Continuidad con lo que ya existe |
| 0 | Prueba real de `AI_PROVIDER=claude` y costo por conversación | clave en entorno aislado | S | Cifra real de costo de IA |

S = una sesión de trabajo; M = dos o tres; L = cuatro o más. Son órdenes de magnitud, no compromisos.

### 2.1 Eventos de dominio

**Objetivo.** Que cada hecho relevante quede registrado una sola vez en una tabla `domain_events` (tipo, entidad, carga, actor, origen, idempotencia) y que los módulos reaccionen a eventos en vez de llamarse entre sí. Tipos iniciales: `conversacion.abierta`, `oportunidad.etapa`, `pedido.creado`, `pago.confirmado`, `pago.rechazado`, `comprobante.recibido`, `inscripcion.activada`, `inscripcion.cancelada`, `mensaje.entregado/fallido`, `baja.registrada`.

**Alcance.** Tabla + publicador (`events.publish`, dentro de la transacción del llamador) + suscriptores en proceso con reintento (misma mecánica que `automation_steps`) + vista «Eventos» en Operación (administración) con filtro por tipo, marca y entidad + exportación CSV. Los módulos existentes publican sin cambiar su comportamiento (pagos, canal, recetas, consentimiento). El webhook de conectores publica lo que aplica.

**Fuera de alcance.** Cola externa, consumidores fuera del proceso, retención/borrado (Fase 4).

**Criterios de salida.** Cada flujo ya probado (pago simulado, comprobante, canal, baja) deja su evento con idempotencia demostrada en pruebas; la vista muestra los últimos 200 eventos por marca; documentación en ARQUITECTURA con el catálogo de tipos y su carga.

**Riesgos.** Duplicar información que ya está en `payment_events`, `channel_events`, `crm_events`: la regla es que esas tablas siguen siendo el detalle de su módulo y `domain_events` es el índice común (referencia, no copia).

### 2.2 Identidad única de persona

**Objetivo.** Una `persona` (teléfono normalizado E.164 + correo + nombre + consentimiento) a la que cuelgan los contactos por marca que ya existen, para ver el historial de alguien a través de consultoras y no duplicar inscripciones ni certificados.

**Alcance.** Tabla `personas`, columna `contacts.persona_id`, normalización de teléfono (país por omisión México), unión automática por teléfono o correo iguales con revisión humana cuando sólo coincide el nombre (reutilizar la fusión con vista previa que ya existe), ficha de persona (marcas, oportunidades, pedidos, inscripciones) respetando el alcance: un asesor ve sólo lo de sus marcas. Consentimiento pasa a nivel persona con historial.

**Fuera de alcance.** Verificación del teléfono (llega con Meta), importación masiva de personas (puede ir en 2.8 o con la importación CSV).

**Criterios de salida.** Dos conversaciones de la misma persona en marcas distintas comparten ficha; el simulador respeta identidades; pruebas de normalización y de alcance; exportación de contactos incluye el identificador de persona.

**Riesgos.** Los clientes de prueba no tienen teléfono real: usar el número de prueba como teléfono hasta que exista el canal real.

### 2.3 Coordinación académica

**Objetivo.** Que la «apertura» del panel IPCIL y la «cohorte» de la Academia sean una sola cosa sobre la `edición` que ya existe: mínimo de alumnos, inscritos (desde `enrollments`), sesiones con fecha y enlace de Google Meet, grupo de WhatsApp (enlace registrado, no creado), materiales y grabaciones (enlaces o archivos en biblioteca), asistencia y cierre.

**Alcance.** Tablas `sessions`, `attendance`, `edition_resources`; campos de apertura en `editions` (mínimo, estado planeada/abierta/en curso/cerrada/cancelada, responsable); vista **Coordinación** (equipo con acceso a la marca; acciones de cierre sólo administración o responsable) con avance contra el mínimo, lista de inscritos con pago y contacto, calendario de sesiones, botón «crear evento de Meet» que en el laboratorio genera un enlace simulado y queda listo para la API de Google Calendar; recordatorios por evento (`sesion.proxima`) que usan plantillas aprobadas; la venta confirmada entra sola (suscriptor de `pago.confirmado`). Rol operativo «coordinador» como **función** del usuario (etiqueta que filtra vistas y avisos), sin cambiar el modelo de permisos por marca.

**Fuera de alcance.** API real de Google Calendar/Meet y Bunny (se preparan adaptadores en el contrato de conectores), encuestas, pagos por sesión.

**Criterios de salida.** Flujo completo en simulación: apertura con mínimo 5 → cinco pagos simulados → estado «abierta» → sesiones con recordatorio → asistencia → «cerrada»; el modo presentación suma un paso de coordinación; pruebas y documentación.

### 2.4 Finanzas

**Objetivo.** Libro de ventas alimentado por eventos (pago confirmado, comprobante validado, cancelación, reembolso cuando exista) con ingresos por día/semana/mes, consultora, curso y vendedor; comisiones a consultoras y vendedores con una regla única configurable; conciliación (simulada hoy, Stripe mañana); exportación a CSV/Excel y PDF; rol de contadora de solo lectura más «marcar comisión pagada».

**Alcance.** Tablas `ledger_entries`, `commission_rules`, `commission_payouts`; vista **Finanzas** (administración y función «contadora»); exportación CSV y una vista imprimible (PDF desde el navegador) sin dependencias nuevas; cifras cruzadas con Analítica y Presentación para que digan lo mismo.

**Fuera de alcance.** Facturación CFDI, nómina, integración bancaria.

**Criterios de salida.** Cada pago de la Fase 1 aparece una vez en el libro; comisiones calculadas y auditables; exportaciones verificadas en prueba; el total del modo presentación coincide con el libro.

### 2.5 Certificación

**Objetivo.** Un solo emisor: al cerrar una apertura con asistencia cumplida se emite el certificado (folio secuencial `IPCI-AAAA-NNNNN` compatible con la Academia, PDF/SVG, código QR) y existe la verificación pública `/verificar/<folio>` sin sesión. Evento `certificado.emitido`; créditos de certificado por consultora si se mantiene ese modelo.

**Alcance.** Tablas `certificates`, `certificate_credits`; emisión manual y automática al cierre; plantilla visual por marca (logo, firma) con la ficha SVG de respaldo; descarga y envío por el chat con plantilla aprobada; verificación pública con límite de peticiones.

**Fuera de alcance.** Migrar los folios históricos de la Academia (2.8), firma digital avanzada.

**Criterios de salida.** Un alumno inscrito y con asistencia recibe su certificado y el enlace verifica en público; el folio no se repite ni con dos emisiones concurrentes; pruebas y documentación.

### 2.6 Contenido

**Objetivo.** Cerrar el ciclo de mensajes del curso con plantillas por evento (bienvenida por anuncio, pago pendiente, pago confirmado, recordatorio de sesión, grabación disponible, certificado listo), roles de contenido (diseño sube, coordinación aprueba, venta usa), generador de fichas SVG/PNG desde los datos del curso y variantes redactadas por la IA que una persona aprueba.

**Alcance.** `templates.event` (mapa evento → plantilla aprobada por marca), suscriptores que envían con las reglas de canal (categoría, ventana), fichas generadas con caché por versión, función «diseñador»; variantes asistidas por el adaptador de IA (simulado sin clave) con aprobación y versión.

**Criterios de salida.** Un pago confirmado dispara la plantilla de confirmación de la marca; una sesión próxima dispara el recordatorio; nada se envía sin plantilla aprobada; pruebas y documentación.

### 2.7 Núcleo Postgres/Supabase y ruta de migración

**Depende de la decisión 7.1 de la visión y del acceso al proyecto de Supabase de la Academia.** Dos rutas, en orden de recomendación:

1. **Núcleo compartido primero, CRM intacto.** Se crea en Postgres el esquema unificado (persona, consultora, curso, edición, pago, inscripción, certificado, evento) y el CRM lo alimenta con un **outbox** de sus eventos de dominio (2.1) y lee de él lo que necesite (identidad, inscripciones de la Academia). El CRM sigue en SQLite para su operación diaria. Ventaja: la Academia y el IPCIL nuevo ven el mismo núcleo en semanas, sin tocar los 18 esquemas del CRM. Riesgo: dos copias temporales de algunos datos, resueltas por eventos idempotentes.
2. **Migración completa del CRM a Postgres.** Capa de acceso a datos sobre `pg`, revisión de todo el SQL específico de SQLite (`json_extract`, `PRAGMA`, `INSERT OR IGNORE`, `rowid`, transacciones síncronas), migraciones equivalentes y pruebas contra una base de prueba. Es la ruta correcta a largo plazo y la más cara; conviene hacerla **después** de que el núcleo compartido exista y módulo por módulo.

**Criterios de salida (ruta 1).** Esquema del núcleo versionado y documentado; outbox con reintento y pruebas; un evento de pago del CRM visible en el núcleo; lectura de inscripciones de la Academia en la ficha de persona.

### 2.8 Puente con IPCIL

Hasta que exista el IPCIL nuevo: sólo lectura de históricos (alumnos, aperturas, certificados) a la ficha de persona y al libro de finanzas mediante importación CSV/JSON; el panel actual en Firebase se toma como referencia de roles (vendedor, coordinador, admin, trafiquer, rh, validar) para las **funciones** de usuario de 2.3 y 2.4. Sin adaptadores en vivo a Firestore.

### 0. Prueba real del proveedor de IA

Con una clave de prueba en un entorno aislado (nunca el de producción): activar `AI_PROVIDER=claude` en una marca de laboratorio, correr el banco de evaluación en nivel autónomo, medir tokens y costo por conversación con el simulador (20 clientes), y documentar umbral de puntuación para permitir el nivel 3 por marca. Modelo inicial `claude-haiku-5-5` para rutina; `claude-opus-5-5` para evaluación.

## 2. Decisiones que se necesitan (y qué pasa si no llegan)

| Decisión | Para qué bloque | Si no llega |
| --- | --- | --- |
| Base única Postgres/Supabase y acceso al proyecto de la Academia | 2.7 | 2.1–2.6 avanzan igual dentro del CRM; 2.7 se queda en ruta 1 preparada (outbox listo) |
| Regla de comisiones (consultoras y vendedores) y quién valida comprobantes | 2.4 | Se implementa una regla por omisión configurable y se documenta |
| Un solo emisor de certificados y qué pasa con los créditos del panel IPCIL | 2.5 | El CRM emite con folio compatible y créditos opcionales; se migra al servicio común después |
| Proveedor de IA, presupuesto mensual y política de datos | 0, 2.6 | Todo sigue con el adaptador simulado |
| Dónde viven los archivos (Supabase Storage, R2, S3) y retención | 2.3, 2.5 | Archivos siguen en el volumen del servidor con referencia en la base, como hoy |
| Google Workspace para Meet/Calendar por API | 2.3 | Enlaces de Meet registrados a mano; adaptador listo |

## 3. Lo que no cambia

Las reglas del repositorio: alcance por marca en servidor, precios y fechas sólo del catálogo, `expectedRevision` y `clientRef`, transacciones sin red, migraciones aditivas con respaldo previo, diseño Niebla medible, nada publicado sin instrucción. La Fase 3 (canales reales y piloto) sigue dependiendo de los accesos de las consultoras: conviene **iniciar ya los trámites de Meta** (verificación de empresa, números, plantillas) en paralelo a la Fase 2, porque tardan más que el código.

## 4. Primer bloque recomendado

**2.1 Eventos de dominio + arranque de 2.3 Coordinación académica** en la misma rama: la columna vertebral es pequeña y la coordinación es lo más visible que falta para contar la historia completa (anuncio → chat → pago → inscripción → apertura → sesión → certificado). Criterio de cierre del primer bloque: la venta confirmada aparece sola en la apertura, con eventos registrados, pruebas y un paso nuevo en el guion de presentación.
