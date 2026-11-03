# Plataforma TEC Capital: diagnóstico y plan maestro

Fecha: 31 de octubre de 2026. Escrito tras analizar el CRM laboratorio, los repositorios de la empresa (`teccapitalweb`, `tec-capital-group`), el panel IPCIL (`ricricard21/IPCIL-OFICIAL`), la Academia IPCI (`tec-capital-group/teccapital-academia`), el panel y webhook de Visión Pecuaria, la documentación oficial de Meta y el mercado de CRM conversacionales. Las fuentes están al final. Donde hay una estimación, se dice que lo es.

## 1. Qué quiere la empresa (en una frase)

Una plataforma única que **venda semiautomáticamente** por WhatsApp, Instagram y Facebook para ~15–20 consultoras, **registre todo con detalle**, pase cada venta al **coordinador** que arma el grupo y da el curso, emita el **certificado IPCIL** con QR, y entregue a la **contadora** los números limpios; con flyers y plantillas controlados por un equipo de contenido, y con IA que primero ayude y después opere sola con supervisión. Y que salga **más barato** que WATI.

## 2. Lo que ya existe (inventario real)

| Pieza | Dónde | Tecnología | Qué resuelve hoy |
|---|---|---|---|
| **CRM laboratorio** (este repo) | `teccapitalweb/tec-capital-crm-laboratorio`, Railway | Node + SQLite + WebSocket | Bandeja multicanal **simulada**, cola y reparto, catálogo con ediciones/promos/flyers/plantillas, contactos, oportunidades, tareas, analítica, recetas, consentimiento, 2FA, respaldos. v0.14.0, 111 pruebas |
| **Panel IPCIL** | `ricricard21/IPCIL-OFICIAL` (`panel/`) | HTML + Firebase (Firestore/Auth), GitHub Pages | Los **roles reales**: `vendedor` (registro de ventas, cronograma, comisiones, invitar a curso, abrir grupo), `coordinador` (cursos, vendedores, alumnos, **aperturas de grupo** con mínimo de alumnos, sesiones, metas), `admin` (dashboard global, consultoras, comisiones, ranking, certificados), `trafiquer` (captura de pauta, decisiones del gerente), `rh` (postulaciones por WhatsApp), `validar` (certificado por folio). Colecciones: `alumnos`, `aperturas`, `cursos`, `certificados`, `consultoras`, `usuarios`, `solicitudesWhatsapp`, `metricasPauta`, `decisionesGerente`, `accionesTrafico`. Estados del alumno: `registrado → pendiente → activo → email_enviado → certificado_generado` / `cancelado`. Modelo de cobro a consultoras: mensualidad, vendedor extra y créditos de certificado |
| **Academia IPCI** | `tec-capital-group/teccapital-academia` (Sprint 0, privado) | Next.js + Fastify + **Supabase/Postgres** + Stripe | El modelo de datos más serio: `consultoras` (comisión %), `cursos` (autogestivo / acompañado), `cohortes`, `sesiones_en_vivo`, `recursos`, `avisos`, `pagos` (card/OXXO/SPEI, confirmados **solo por webhook**), `inscripciones`, `certificados` (folio `IPCI-AAAA-NNNNN`, verificación pública), `comisiones` por consultora, `cupones`, `vales_acceso` (Puente Sinergia, HMAC, idempotente) |
| **Clubs y webhooks por consultora** (~30 repos) | `teccapitalweb/*-club`, `*-webhook`, `dermalysse-platform`, Visión Pecuaria… | Express + Firebase + Stripe + Bunny Stream + Resend, en Railway | Membresías VIP, checkout, videos protegidos, correos. **Cada consultora tiene su Firebase y su Stripe** |
| **Panel Visión Pecuaria** | `teccapitalweb/VisionPecuaria-ADMIN` | HTML + Firebase | Miembros, pagos pendientes, cursos, sesiones, PDFs, certificados |

### 2.1 Dos líneas de producto que no deben mezclarse

| | **Cursos en vivo** | **Membresías / clubs** |
|---|---|---|
| Qué es | Un curso con fecha: se anuncia, se vende por chat, se abre un grupo con mínimo de alumnos, se imparte en vivo por Meet, se graba y termina en certificado IPCIL | Suscripción (mensual/anual) al club de una consultora, en **su propio sitio y dominio**: biblioteca de cursos **pregrabados**, un curso de regalo con todas las clases abiertas **menos la última**, materiales, retos y minijuegos |
| Quién lo opera | Vendedores (venta), coordinador (apertura, ponente, sesiones, grabaciones), IPCIL (certificado) | El sitio del club con su webhook (Stripe + Firebase + Bunny); no pasa por vendedores ni por aperturas |
| Dónde vive hoy | Panel IPCIL (`aperturas`, `alumnos`) y, en la Academia, la modalidad `acompanado` con `cohortes` | Repos `*-club` / `*-webhook` por consultora (el de Synova describe exactamente el curso gratis «todas las clases menos la última») |
| Papel en esta plataforma | **Es el flujo central**: todo el capítulo 3 y la venta semiautomática del 4.3 son de cursos en vivo | **Producto aparte.** No se migra ni entra al flujo de ventas. Se conecta sólo para dos cosas: saber si una persona ya es socia (señal útil al vender y para ofrecer la membresía, como ya hace el botón «Membresía» del panel del vendedor) y que su ingreso llegue al mismo libro de finanzas |

**Diagnóstico honesto:** la empresa ya tiene casi todas las piezas, pero en **tres modelos de datos distintos** (SQLite del CRM, Firestore de IPCIL y de cada club, Postgres de la Academia) y con **dos emisores de certificados** (panel IPCIL y Academia). El alumno existe repetido en varios lados, el pago vive en el Stripe de cada consultora y nada conecta la conversación con la inscripción. El problema a resolver no es construir más pantallas: es **un núcleo de datos único y un flujo de punta a punta**.

## 3. El flujo real, de punta a punta

```
Trafficker            Cliente              Vendedor                 Coordinador                 Contadora
publica anuncio  →  clic a WhatsApp  →  atiende / cierra  →  valida pago, arma apertura  →  ve ingresos,
(FB/IG/TikTok)      (o IG/FB DM)        registra venta        (mínimo de alumnos, ponente,    comisiones,
                                        y comprobante         Meet, grupo WhatsApp,           nómina, reportes
                                                              materiales, grabaciones)
                                                                      ↓
                                                        Certificado IPCIL con QR (al terminar)
```

Dónde se rompe hoy: la venta se captura a mano en el panel del vendedor; el comprobante llega como imagen por chat y alguien lo valida a ojo; el coordinador no ve la conversación; el certificado se puede emitir desde dos sistemas; la contadora reconstruye los números de Stripe y de capturas manuales.

## 4. Arquitectura objetivo

### 4.1 Un núcleo, varios módulos

```
                 ┌──────────────── Plataforma TEC Capital ────────────────┐
Canales          │  CRM Ventas   Operación académica   Certificación IPCIL │  Finanzas
WA / IG / FB ──► │  (bandeja,    (aperturas/cohortes,  (folio, QR,         │  (ventas, comisiones,
simulado hoy,    │  catálogo,    sesiones, materiales, verificación)       │  nómina, PDF/Excel)
Meta mañana      │  recetas, IA) grabaciones, grupos)                      │
                 │  Tráfico (pauta ↔ conversaciones ↔ ventas)   Contenido (flyers, plantillas, aprobación)
                 ├────────────────── Núcleo de datos único (Postgres) ─────────────────┤
                 │  persona · consultora · curso · edición/cohorte · conversación ·     │
                 │  oportunidad · pago · inscripción · certificado · comisión · evento  │
                 ├───────────── Integraciones ─────────────┤  Almacenamiento de archivos
                 │  Meta Cloud API · Stripe · Google Meet/ │  (objetos: comprobantes, flyers,
                 │  Calendar · Bunny · Resend · Sheets     │   grabaciones; nunca en la base)
                 └─────────────────────────────────────────┴────────────────────────────┘
```

**Decisiones de fondo:**

1. **Postgres como base única.** La Academia ya eligió Supabase/Postgres y su esquema es el mejor de los tres. El CRM migra de SQLite a Postgres cuando se integre (su diseño ya lo prevé: una instancia, migraciones versionadas). Los clubs siguen siendo productos aparte en sus sitios; sólo comparten identidad de persona y libro de finanzas mediante eventos (ver 2.1). No se migran.
2. **Una sola identidad de persona** (teléfono normalizado + correo), con consentimiento, a la que cuelgan conversaciones, compras, inscripciones y certificados de cualquier consultora. Permisos por consultora en servidor (ya lo hace el CRM).
3. **Eventos, no copias.** Cada módulo publica hechos (`pago.confirmado`, `inscripcion.activada`, `apertura.abierta`, `certificado.emitido`) en una tabla de eventos con idempotencia; los demás reaccionan. Así la conversación, la coordinación y la contabilidad ven lo mismo.
4. **Archivos fuera de la base.** Comprobantes, flyers y grabaciones van a almacenamiento de objetos (Supabase Storage, Cloudflare R2 o S3; Bunny ya se usa para video), con URL firmada, miniatura y **política de retención** (p. ej. comprobantes 5 años, imágenes de chat 12 meses). La base solo guarda la referencia. Esto responde a la preocupación de que «las imágenes saturen el sistema»: no saturan si no viven en la base; el costo de objetos es de centavos por GB al mes (verificar tarifa del proveedor elegido). Un botón **«Exportar todo»** genera un paquete con la base y el manifiesto de archivos; no hace falta una app de escritorio para eso, y una PWA cubre el uso en celular.
5. **Web, no escritorio.** Una web responsiva (como el CRM actual) sirve a vendedores en el celular y a coordinación y contabilidad en computadora. Un programa de escritorio no aporta nada que justifique mantener dos productos.

### 4.2 Canales oficiales: directo con Meta, con una capa de conectores

- **Hoy:** el CRM habla con un **adaptador simulado**. El plan es definir el contrato del conector (entrada: mensaje, estado, referral de anuncio; salida: texto, plantilla, medios, botones) y que el simulado y el real lo cumplan igual. Así «cuando lleguen las APIs solo se conecta».
- **Mañana:** **WhatsApp Cloud API directo** (sin proveedor intermedio) para Mensajería de WhatsApp, y Messenger/Instagram por la Graph API. Razones, con datos oficiales de Meta: el cobro es **por mensaje entregado**, los mensajes del cliente no cuestan, cada número tiene **1 000 mensajes de servicio gratis al mes**, y los mensajes dentro de la ventana de un anuncio «clic a WhatsApp» **no se cobran** (esa ventana puede durar hasta 7 días). Un proveedor como WATI cobra además suscripción por usuario y contactos activos; los BSP añaden un margen por mensaje (una fuente de terceros habla de ~20 %). Con 15–20 marcas y decenas de vendedores, el directo es claramente más barato; el costo es nuestro desarrollo y la verificación del negocio en Meta.
- **Lo que exige Meta y hay que prever en la simulación:** la **ventana de 24 h** (fuera de ella solo plantillas aprobadas), **categorías de plantilla** (marketing / utilidad / autenticación) con revisión, **opt-in** demostrable para marketing, estados `sent/delivered/read/failed` con códigos de error, y el objeto **referral** del anuncio (incluye `ctwa_clid` y datos del anuncio) que permite **saber qué flyer o anuncio tocó el cliente** y responder con el curso correcto sin que escriba nada. Eso es exactamente la bienvenida automática que describiste.
- **Grupos de WhatsApp:** la Cloud API **no crea grupos** hoy. Lo que sí se puede automatizar es generar y enviar el enlace de invitación del grupo que el coordinador crea una vez desde la app de WhatsApp Business, y registrar quién recibió el enlace. Verificar al implementar si Meta ha abierto una API de grupos; no diseñar el flujo contando con ella.
- **Qué hay que pedir a cada consultora:** verificación de negocio en Meta, propiedad (o acceso de administrador) de sus páginas de Facebook e Instagram y de su número de WhatsApp (un número no puede estar a la vez en la app y en la API), nombre comercial y catálogo oficial. Conviene centralizar todo en **un portafolio empresarial de TEC Capital con varias WABA/números**, uno por consultora.

### 4.3 La venta semiautomática (cómo funciona el «vende solo»)

Cuatro niveles por consultora, configurables y con bitácora de **por qué** respondió cada cosa:

| Nivel | Qué hace la máquina | Qué hace la persona |
|---|---|---|
| 0 Apagado | Nada | Todo |
| 1 Sugiere | Propone respuesta con fuentes (catálogo + conocimiento aprobado) | Edita y envía |
| 2 Responde con plantillas | Contesta precio, fechas, temario, requisitos, certificado, formas de pago; envía flyer vigente; recoge nombre y correo; **genera el enlace de pago** | Interviene si el cliente lo pide o si hay duda |
| 3 Cierra y escala | Además confirma inscripción cuando Stripe confirma el pago, agenda el seguimiento, avisa al coordinador; escala si detecta enojo, reembolso, negociación o pregunta sin fuente | Supervisa colas de excepciones |

Reglas no negociables: precio, fechas y cupos **siempre** de la base (nunca de la memoria del modelo); nunca confirmar un pago por una imagen (solo el webhook de Stripe o una validación humana del comprobante); consentimiento y tope de frecuencia (ya existen en el CRM); cada respuesta automática deja **fuente, versión de plantilla y modelo** en el registro.

**Comprobantes de transferencia:** el cliente los manda por chat; la plataforma los guarda en almacenamiento de objetos, los liga a la oportunidad y abre una **cola de validación** (coordinador o contadora). La IA puede leer la imagen y **pre-llenar** monto, fecha y referencia para acelerar, pero la confirmación es humana. Al validar, se emite el mismo evento `pago.confirmado` que emite Stripe, y el resto del flujo no distingue.

### 4.4 Plantillas y flyers «inteligentes»

Ya existe la base en el CRM: plantillas con variables (`{{precio}}`, `{{fecha}}`, `{{docente}}`…), flyers con aprobación, versiones y caducidad, y el precio vigente se calcula al enviar. Lo que falta para el nivel que pides:

- **Roles de contenido:** diseñador (sube flyer), coordinador (aprueba contra los datos del curso), vendedor (solo usa lo aprobado).
- **Plantilla por evento:** bienvenida por anuncio, precio, fechas, pago pendiente, pago confirmado, recordatorio de clase, grabación disponible, certificado listo. Cada una mapeada a una plantilla **aprobada por Meta** cuando aplique fuera de la ventana de 24 h.
- **Generación asistida:** la IA redacta variantes a partir de la plantilla base y los datos del curso; una persona aprueba; la variante queda versionada. Nunca se envía texto generado sin aprobar fuera del nivel 3.
- **Flyer con texto vivo:** el flyer estático no se corrige solo; conviene un **generador de fichas** (SVG/PNG desde los datos del curso) para fechas y precios, y dejar el arte del diseñador como fondo. El CRM ya tiene una ficha SVG de respaldo.

### 4.5 Coordinación académica

Unificar el «apertura» del panel IPCIL con la «cohorte» de la Academia (son lo mismo): curso + fecha de inicio + mínimo de alumnos + ponente + sesiones (Meet) + grupo de WhatsApp + materiales + grabaciones. La venta confirmada **entra sola** a la apertura; el coordinador ve el avance contra el mínimo (ya lo calcula el panel IPCIL), programa sesiones (crear el evento de Google Meet por API es posible con Google Calendar), publica materiales y grabaciones (Bunny), y al cierre marca asistencia para emitir certificados.

### 4.5b Sobre el IPCIL nuevo

El usuario indicó que IPCIL se va a **rehacer** con un nivel mucho más profesional. Consecuencia para este plan: el panel actual en Firebase se toma como **referencia de roles y flujos** (vendedor, coordinador, admin, trafiquer, rh, validar), no como destino de integración. El CRM y el resto de módulos se conectan al **núcleo de datos compartido** (sección 4.1); cuando exista el IPCIL nuevo, consumirá ese mismo núcleo y los eventos (`pago.confirmado`, `inscripcion.activada`, `apertura.abierta`, `certificado.emitido`). No invertir en adaptadores a las colecciones actuales de Firestore más allá de lo necesario para leer históricos.

### 4.6 Certificación IPCIL

Un solo emisor: el servicio de certificados de la Academia (folio secuencial desde la base, PDF, verificación pública en `/verificar/[folio]`). El panel IPCIL pasa a **consumirlo**, no a emitir por su cuenta. Créditos de certificado por consultora, si se mantiene ese modelo de cobro, se descuentan en el mismo evento.

### 4.7 Finanzas para la contadora

Un libro de ventas alimentado por eventos: pago Stripe confirmado, transferencia validada, reembolso. Desde ahí: ingresos por día/semana/mes/periodo, por consultora, por curso, por vendedor; **comisiones** a consultoras (ya modeladas) y a vendedores (el panel IPCIL las muestra; falta la regla única); conciliación contra Stripe; exportación a **PDF y Excel**; rol de contadora de solo lectura más «marcar comisión pagada». La nómina completa (sueldos, impuestos) es otro sistema: la plataforma le da los insumos, no la sustituye.

### 4.8 IA: proveedor, costos y control

- **Capas:** (1) plantillas con variables (ya); (2) motor de respuestas con **conocimiento aprobado por consultora y curso** (requisitos, certificado, pagos, preguntas frecuentes) más catálogo vigente; (3) copiloto del vendedor; (4) operación autónoma con escalamiento y evaluación.
- **Proveedor:** un **adaptador** para poder cambiar de modelo. Primario: API de Claude (ya hay crédito mensual). Modelos y precios oficiales por millón de tokens: **Haiku 5.5** 0,10 $ entrada / 0,50 $ salida (clasificar intención y redactar respuestas de rutina), **Sonnet 5.5** 2 $/10 $ (casos con más criterio), **Opus 5.5** 4 $/20 $ (evaluación y casos difíciles). Con **caché de prompts** el catálogo y las reglas de cada marca se pagan una vez por ventana, y los trabajos nocturnos (resúmenes, evaluación) van por **lotes a mitad de precio**. Sobre «DeepSeek 4.1 Flash»: no verifiqué ese nombre ni su precio; antes de incluirlo hay que confirmar modelo, precio y, sobre todo, su política de datos (los chats contienen datos personales de clientes).
- **Estimación de costo (orden de magnitud, no cotización):** una conversación de venta de ~20 turnos atendida por Haiku con el contexto en caché cuesta del orden de **un centavo de dólar**; 10 000 conversaciones al mes rondarían 100–150 $ sin contar evaluación. El crédito mensual actual cubre de sobra la simulación y un piloto. Medirlo con contadores por marca desde el primer día (el CRM ya registra consumo por paso).
- **Evaluación antes de autonomía:** un banco de preguntas con respuesta esperada por curso (precio, fecha, certificado, pago, pregunta de otra marca, intento de manipulación) y un puntaje reproducible; no se activa el nivel 3 sin superar el umbral que fije la empresa.

## 5. Qué hacen los demás y qué copiamos

| Referencia | Qué hace bien | Qué tomamos |
|---|---|---|
| **WATI** | Bandeja + chatbot + difusiones listo para usar | Nada técnico; es el costo a batir: suscripción por usuario y contactos activos, más mensajes de Meta |
| **Respond.io** | Constructor de automatizaciones y agentes de IA para alto volumen, integración con CRM | El diseño de flujos con condiciones y la trazabilidad de cada acción |
| **Kommo** | WhatsApp dentro de un embudo de ventas clásico | La vista de embudo por etapa (ya la tenemos) |
| **Chatwoot** | Bandeja multicanal **open source**, autoalojable | Referencia de arquitectura de conectores y de bandeja; no sustituye nuestro núcleo de negocio |
| **Leadsales, Clientify, Funnelchat** | CRM de WhatsApp para instituciones educativas en Latinoamérica | Botón de WhatsApp en páginas, anuncios con mensaje directo, chatbot que filtra preguntas frecuentes y deriva a asesores |
| **Hotmart / Thinkific / LearnWorlds** | Venta de cursos con afiliados y comisiones; cobran % o cuota por inscripción | El modelo de afiliado por consultora ya está en la Academia, sin pagarles comisión a ellos |
| **Moodle / Open edX** | LMS open source sin cobros nativos | No conviene: la Academia ya cubre contenido y pagos |

**El diferenciador de TEC Capital** no es la bandeja ni el chatbot (eso lo venden diez empresas): es la **integración vertical** venta → apertura/cohorte → clase → certificado IPCIL → comisiones y contabilidad, para muchas marcas bajo un mismo techo. Ningún producto del mercado da eso completo.

## 6. Plan por fases

### Fase 1 (ahora, sin depender de nadie): simulación convincente y contrato de integración
1. **Motor de respuestas v2** en el CRM: conocimiento aprobado por marca/curso, intenciones, niveles 0–3 por marca, explicación de cada respuesta. Adaptador de IA con Claude y modo «simulado» para demos sin costo.
2. **Simulador de clientes** con guiones (curioso, precio, listo para pagar, molesto, baja) y velocidad ajustable, más **datos de demostración a escala** (15 marcas, 8 cursos cada una, semanas de historial) con botón de reinicio. *Hecho localmente el 31 oct 2026 (guiones, ritmo, métricas en vivo, detener/archivar, catálogo 15×8 idempotente); falta el historial retroactivo de semanas.*
3. **Canal simulado realista:** estados enviado/entregado/leído/fallido, ventana de 24 h, plantillas de marketing vs servicio, botones, y **referral de anuncio** simulado (el clic al flyer dispara la bienvenida del curso correcto). *Hecho localmente el 31 oct 2026 (estados, ventana 24/72 h, categorías, botones, referral y enlace de anuncio por flyer; sin costos de proveedor todavía).*
4. **Contrato de conectores** (documento + adaptador simulado) y **documento de requisitos por consultora** para Meta. *Hecho localmente el 2 nov 2026: `server/connectors.mjs` + `docs/CONECTORES.md` (Meta, Stripe, Conekta; webhooks firmados; requisitos por consultora).*
5. **Venta con pago:** enlace de pago de prueba (Stripe en modo test de la Academia), webhook simulado, **cola de validación de comprobantes** con pre-lectura por IA, evento `pago.confirmado` → inscripción → aviso al coordinador. *Hecho localmente el 31 oct 2026 con proveedor simulado (sin Stripe todavía): pedido, enlace, pago simulado, cola de comprobantes con pre-lectura declarativa, inscripción, cupo, ganada y aviso.*
6. **Modo presentación:** tablero con % de chats resueltos sin intervención, tiempo de respuesta máquina vs humano, ventas por marca, y guion guiado. *Hecho localmente el 2 nov 2026 (vista Presentación con tablero, costo estimado por categoría y guion de 10 pasos con comprobaciones).*

### Fase 2 (3–6 meses): núcleo único e integración con lo existente
7. Migrar el CRM a **Postgres** (Supabase, junto a la Academia) y definir el esquema unificado de persona, pago, inscripción, certificado y evento.
8. **Puente con el panel IPCIL:** el registro de venta del vendedor y la apertura del coordinador se alimentan desde la plataforma; el certificado se emite desde un solo servicio.
9. **Módulo de coordinación** (aperturas/cohortes, sesiones con Meet por API, materiales, grabaciones, asistencia).
10. **Módulo de finanzas** (libro de ventas, comisiones, conciliación Stripe, PDF/Excel).
11. **Contenido:** roles de diseño/aprobación, plantillas por evento, generador de fichas, variantes asistidas por IA.

### Fase 3 (cuando lleguen accesos): canales reales y piloto
12. Portafolio de Meta de TEC Capital, WABA y números por consultora, plantillas aprobadas, webhooks firmados, conector real; Instagram y Messenger.
13. **Piloto** con una consultora y dos cursos en nivel 1–2; medir con el banco de evaluación; subir a nivel 3 por marca cuando se cumplan los umbrales.
14. Tráfico: ligar `ctwa_clid` y campañas con conversaciones y ventas (el panel `trafiquer` ya captura pauta); costo por venta por anuncio.

### Fase 4 (escala): 15–20 consultoras
15. Observabilidad (alertas, panel de salud), retención y borrado, exportación completa, cuotas de IA por marca, roles finos (supervisor, contadora), turnos de vendedores, PostgreSQL con réplicas y cola externa si el volumen lo pide.

## 7. Decisiones que solo tú puedes tomar

1. **Base única en Postgres/Supabase** junto a la Academia (recomendado) o mantener Firebase en IPCIL y conectar por eventos durante más tiempo.
2. **Meta directo** (recomendado por costo) o proveedor para arrancar rápido y migrar después.
3. **Un emisor de certificados** (Academia) y qué pasa con los créditos de certificado del panel IPCIL.
4. **Proveedor de IA y presupuesto mensual**; política de datos personales en los prompts.
5. **Quién valida comprobantes** (coordinador, contadora o ambos) y la regla de comisiones de vendedores.
6. **Dónde se guardan los archivos** (Supabase Storage, R2, S3) y la retención por tipo.

## 8. Riesgos y verdades incómodas

- **Grupos de WhatsApp automáticos** no son posibles con la API oficial hoy; se automatiza el enlace, no la creación.
- **La verificación de negocio y la aprobación de plantillas en Meta** tardan y pueden rechazarse; empezar los trámites antes de que el código esté listo.
- **Tres bases de datos** es el riesgo principal de inconsistencia; cada mes que pase sin núcleo único cuesta más migrar.
- **La IA solo es confiable con datos confiables:** si el catálogo real no está cargado y aprobado, la automatización repetirá errores con mucha eficiencia.
- **Datos personales:** teléfonos, correos y comprobantes exigen consentimiento, retención, acceso por rol y un proveedor de IA con política de datos adecuada; antes de clientes reales, revisarlo con asesoría legal.
- **Costos de Meta** cambian con frecuencia (la propia página oficial registra cambios en 2025 y 2026); presupuestar con la tarjeta de tarifas vigente, no con blogs.

## Fuentes consultadas

- Meta, WhatsApp Business Platform, precios: <https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing>
- Meta, componentes de webhooks: <https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components>
- Meta, ejemplos de payload: <https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples>
- Meta, índice de documentación (referral, estados, plantillas, opt-in): <https://developers.facebook.com/documentation/business-messaging/whatsapp/llms.txt>
- Precios de WhatsApp API en México (terceros, verificar): [Aurora Inbox](https://www.aurorainbox.com/en/precio-whatsapp-business-api-mexico-2026/), [ChatDaddy](https://www.chatdaddy.tech/blog/whatsapp-business-api-pricing), [Hyperleap](https://hyperleap.ai/blog/whatsapp-business-api-pricing-guide-2026), [Go4Whatsup](https://go4whatsup.com/mexico/whatsapp-business-api-pricing/), [EZContact](https://ezcontact.ai/en/blog/2026-05-13-whatsapp-business-api-pricing-what-you-pay-2026-bsps-compared/)
- Comparativas de CRM de WhatsApp (fuentes de proveedores, sesgadas): [Respond.io sobre Kommo](https://respond.io/es/blog/kommo-alternative), [Leadsales sobre Respond.io](https://leadsales.io/blog/alternativas-respond-io/), [Aurora Inbox 2026](https://www.aurorainbox.com/2026/01/23/mejores-crm-whatsapp-2025/), [Techloy](https://www.techloy.com/choosing-a-whatsapp-crm-in-2026-5-platforms-compared-for-growing-teams.md), [InstantDM](https://instantdm.com/blog/respond-io-vs-kommo-2026), [BuilderBot](https://builderbot.cloud/en/respond-io-vs-builderbot), [Capterra WATI vs Respond.io](https://www.capterra.com.sg/compare/179311/204314/rocketbots/vs/wati)
- CRM educativo por WhatsApp en Latinoamérica: [Leadsales](https://leadsales.io/blog/estrategias-captacion-de-alumnos-whatsapp/), [Clientify](https://clientify.com/blog/comunicacion/educacion-whatsapp-alumnos-captar), [Funnelchat](https://funnelchat.com/educacion/?lang=en), [YCloud](https://www.ycloud.com/es/blog/whatsapp-bsp-education-admissions.md), [TeleCRM](https://telecrm.in/blog/whatsapp-automation-for-admissions/), [ChatDaddy México](https://chatdaddy.tech/blog/whatsapp-crm-mexico), [Indigitall](https://indigitall.com/en/blog/filling-summer-intake-how-latam-institutions-capture-students-before-the-july-august-cycle/)
- Plataformas de cursos: [Capterra, alternativas a Hotmart](https://capterra.com/p/219169/Hotmart/alternatives/), [The Front Kit, alternativas a Thinkific](https://thefrontkit.com/blogs/thinkific-alternatives-2026), [LearnWorlds](https://thefrontkit.com/blogs/learnworlds-alternatives-2026), [FreshLearn, alternativas a Moodle](https://freshlearn.com/blog/moodle-alternatives/)
- Precios de la API de Claude: referencia oficial cargada en esta sesión (tabla de modelos vigente al 6 de octubre de 2026); verificar en la página de precios de Anthropic antes de presupuestar.
- WATI (análisis previo en esta misma sesión): <https://www.wati.io/pricing/>
