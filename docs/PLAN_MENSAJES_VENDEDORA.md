# Mensajes al estilo de las consultoras: tono vendedor

**Estado:** **publicado en `main` el 27 nov 2026** (commit `8f807fd`; migración con nombre `replies/0004-tone`, producción en `41+38.d10893ac`; comprobado sin sesión: el código servido trae el selector, `/crm` 200, `/api/replies/settings` 401, `/mcp` 401; falta ver el tachado y los números en emoji en un teléfono real). Sin rutas ni permisos nuevos (el ajuste de respuestas acepta `tone`).

## Por qué

El 27 nov 2026 el dueño mandó dos mensajes reales de una consultora (un anuncio del curso y las instrucciones de pago) y preguntó si los del asistente ya se veían así. A medias: desde el 22 de noviembre llevaban emojis por renglón, negritas y un siguiente paso, pero no el **gancho** del título, la **promoción con el precio anterior tachado**, el **horario sesión por sesión**, el **cupo** cuando quedan pocos lugares, la frase exacta para **asegurar el lugar** ni la **lista de lo que hay que mandar** al pagar. Propuesta de todos los mensajes aprobada en el chat el mismo día («hagámoslo»).

Reglas del dueño respetadas: **no se pierde ninguna opción y no se inventa ninguna**. Cada renglón nuevo sale del catálogo o de Coordinación; si el dato no existe, el renglón no va. Ningún número de cuenta vive en el código: las formas de pago siguen en la imagen «Datos de pago» de la marca.

## Qué hace

### El interruptor «Tono de los mensajes»

Operación → Seguimientos, junto a «Mensajes con emojis»: **Vendedor** (como las consultoras; por omisión) o **Sereno** (el estilo anterior, sin urgencia). `reply_settings.tone`; `PATCH /api/replies/brands/:id` acepta `tone`. Con «Mensajes con emojis» apagado el tono vendedor sale en texto plano: mayúsculas en el título, sin negritas ni tachado, mismos datos.

### Lo que cambia en tono vendedor

| Mensaje | Antes | Ahora |
| --- | --- | --- |
| Ficha (bienvenida) | Título en negritas y datos | `🎓 *¡TÍTULO · EDICIÓN!*`, datos, **horario por sesión**, **cupo** si quedan 10 o menos (y «¡Estamos cerrando inscripciones!» con 3 o menos), `👉 Responde *Quiero inscribirme* para asegurar tu lugar.` |
| Precio con promoción | Una oración con la promoción | `🔥 Precio promocional: *$379.00 MXN*`, `~Antes: $599.00 MXN~`, `⏳ Válido hasta el 29 de noviembre`, «Incluye 3 sesiones en vivo por Google Meet», cupo, siguiente paso |
| Precio sin promoción | Igual | Igual, más «Incluye N sesiones…» cuando Coordinación las tiene |
| Temario | Viñetas | Numerado `1️⃣ 2️⃣ 3️⃣…` (hasta diez puntos; las viñetas o números que ya traía el temario se respetan) |
| Fechas y duración | Inicio, docente, modalidad | Igual, más `🗓️ Horario:` con cada sesión («Lunes 30 de noviembre: 7:00 p.m. a 9:00 p.m.»); con más de ocho, cuántas son y de qué día a qué día |
| «Lo pienso» | Una oración con lo cierto hoy | Cada dato cierto en su renglón: `🔥` promoción y hasta cuándo, `🎈` lugares, o `📅` inicio |
| «Está caro» | El precio y lo que incluye | Igual, con el nombre del curso en negritas y el «antes» tachado si hay promoción |
| Recomendación de cursos | `🎓 Curso — inicia… · precio` | `1️⃣ *Curso*` y debajo `📅 Inicia … · 💳 precio` |

### Lo que cambia en los dos tonos (son datos, no estilo)

- El **horario por sesión** de Coordinación en la ficha, las fechas y la duración.
- El **«antes» tachado** bajo el precio cuando hay promoción vigente y el precio regular es mayor.
- **«¿Cómo pago?» en modo real** (sin respuesta aprobada de pagos): la lista con ✅ de lo que hay que mandar en un solo mensaje (comprobante, nombre para el certificado, correo, WhatsApp), «escribe tu nombre en el concepto» y que una persona valida.
- **Datos para la constancia**: la misma lista con ✅.
- **«No la tengo a la mano»** abre con 🤔.
- Los materiales que el equipo manda desde el chat (Flyer, Temario, Precio, Fechas, con los chips o la Biblioteca) usan **los mismos textos** que el asistente (`catalogue.prepare` llama a `reply-copy`); antes tenían una redacción propia más seca.

### Lo que no cambia

Los mensajes serios (pago en revisión, queja, baja, pasar con una persona) siguen sin emojis ni urgencia. Las frases que entiende el motor («Quiero inscribirme», «asesor») son las mismas. Las plantillas aprobadas por Meta no se tocan. Nada dice «válido únicamente hoy» salvo que la promoción termine ese día (la fecha sale del catálogo).

## Dónde vive

| Pieza | Archivo |
| --- | --- |
| Textos | `server/reply-copy.mjs` (`seller`, `hook`, `sessionLines`, `urgency`, `before`, `includes`) |
| Datos en el contexto | `server/catalogue.mjs` → `info()` añade `sessions` (de `edition_sessions`), `regularPriceCents` y `style` (emojis y tono de la marca) |
| Ajuste por marca | `server/replies.mjs` (`tone` en los ajustes y en el contexto), `public/recipes.js` (selector), migración `server/migrations/named/replies/0004-tone.mjs` |
| Pruebas | `test/reply-copy.test.mjs` («tono vendedor»), `test/sales-replies.test.mjs` (migración y ajuste) |

## Qué sigue

- Que el dueño cargue las **sesiones** de cada apertura en Coordinación: sin ellas no hay horario en los mensajes.
- Probar en WhatsApp real que el tachado (`~texto~`) y los números en emoji se ven bien en el teléfono.
