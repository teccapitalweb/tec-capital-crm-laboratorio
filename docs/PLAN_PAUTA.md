# Plan: Pauta (el panel de tráfico de IPCIL dentro del CRM)

Estado: **implementado en la rama `feat/pauta-trafiquer`** (6 nov 2026), **esquema 29** (sólo tablas nuevas), sin cambio de versión. Sin publicar.

## De dónde sale

El panel IPCIL actual (`ricricard21/IPCIL-OFICIAL`, `panel/trafiquer.html`) es la **referencia de roles y flujos** que dejó pendiente [PLAN_PORTAL_ROLES.md](PLAN_PORTAL_ROLES.md) («trafiquer: faltan reglas del usuario»). Se leyó la página completa (sólo lectura) y se llevó su criterio al CRM, con la ventaja de que aquí **el sistema ya sabe cuántas personas se inscribieron y cuántas conversaciones llegaron**, así que no depende de que alguien las capture.

Equivalencias: consultora = marca · curso lanzado/apertura = edición en venta · alumnos = inscripciones activas · mínimo = `min_students` de la edición (8 si no está definido, como en IPCIL) · `metricasPauta` = capturas diarias · `accionesTrafico` = acciones atendidas · `decisionesGerente` = decisiones del gerente.

## Qué hace (Operación → Pauta)

1. **Campañas.** Un veredicto por edición en venta, de lo más urgente a lo menos: *Van muy bien · súbeles*, *No van a llegar*, *Pueden llegar si les subes*, *Abren hoy sin llenar*, *Van a abrir*, *Recién lanzadas* (se juzgan desde el día 3). Cada tarjeta trae alumnos y mínimo, proyección, pauta, mensajes, costo por mensaje, y la acción recomendada en las palabras del panel de IPCIL. Se marca **atendida** con una nota (la ve todo el equipo, una por edición y día) y se puede desmarcar.
2. **Captura diaria.** Una hoja con el **acumulado** de pauta (pesos) y mensajes de Meta de cada campaña, con el costo por mensaje en vivo, la captura anterior y la advertencia «menor que antes: ¿seguro?». Capturar de nuevo el mismo día corrige. Junto a cada fila se ven las conversaciones que el CRM sí tiene de esa edición (y cuántas llegaron por anuncio). La fecha de lanzamiento se puede fijar por campaña (por omisión, su primera captura).
3. **Decisiones del gerente.** Administración registra *subir*, *bajar* o *pausar* pauta, *apertura pospuesta* (con nueva fecha) o *apertura cerrada*, con presupuesto por día y motivo; queda la **foto de las cifras al momento** y llega un aviso a quienes llevan la pauta. Ellos la marcan **aplicada** con una nota; administración puede cancelarla. Es una instrucción: aplicar el cambio en Meta (o posponer la apertura en Coordinación) sigue siendo una acción de una persona.
4. **Reporte.** Por marca y lanzamiento: pauta, mensajes, costo por mensaje, llenado del mínimo, **costo por alumno** y última captura; totales arriba.
5. **Quién lleva la pauta** (sólo administración): la función de «trafiquer» se concede a personas del equipo, que ven y capturan **sólo las marcas que ya tienen asignadas**. Administración siempre tiene acceso. Los clientes nunca.

## El criterio de los veredictos (`server/ads-engine.mjs`)

Función pura, probada con casos. Igual que el panel de IPCIL:

- **Proyección** de alumnos al abrir con el historial del curso (qué fracción solía haber a estos días de abrir; si el curso tiene poca historia, la de toda la marca; tope de 1.3 veces lo más que ha llevado; sin historial, el ritmo de 14 días).
- **Relanzamiento:** si la corrida anterior del curso cerró sin llegar al mínimo se avisa que, sin cambios en anuncio, segmentación u oferta, repetirá el resultado (y cuántas seguidas han fallado).
- **Diagnóstico** contra la corrida anterior a los mismos días, o contra las demás campañas de la marca: *falta pauta*, *Ads no trae mensajes* o *es ventas, no Ads* (llegan mensajes y no se convierten).
- **Cuánto más invertir:** alumnos que faltan × costo por alumno de la corrida anterior (o el promedio de la marca).

## Datos y límites

- Esquema 29: `ad_access`, `ad_launches`, `ad_captures`, `ad_actions`, `ad_decisions`. Aditivo; respaldo automático previo al migrar (`backups/before-crm-v29-*`).
- **No hay conexión con Meta:** las cifras de pauta y mensajes se capturan a mano (como hoy en IPCIL). Con la conexión real de canales se podrán traer solas.
- Los mensajes «por anuncio» del CRM salen de las conversaciones con anuncio de origen; ya sirven para contrastar contra lo que dice Meta.
- No hay sonido de aviso (el de IPCIL); sí aviso en «Mis avisos».
- **RH** (postulaciones por WhatsApp) y las reglas de comisiones por persona siguen pendientes.

Archivos: `server/ads-schema.mjs`, `server/ads-engine.mjs`, `server/ads.mjs`, `public/ads.js`, estilos `.ads-*` en `public/operations.css`; pruebas `test/ads.test.mjs`.
