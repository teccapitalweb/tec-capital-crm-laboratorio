# Audiencias: listas y segmentos para difundir (D-2)

Estado: **construido en la rama de integración, sin publicar**. Migración con nombre `audiences/0001-audiences` (la escalera sigue en 41). La pantalla nace en vista previa (`SCREENS_PREVIEW=1`). Fuente: diseño de difusiones §3.3 y §4, adaptado a la conciliación técnica (filas 12, 14, 15, 16, 18 y 28), que manda.

## Qué es

- **Lista**: un conjunto fijo de contactos (los de una importación, una selección). Su conteo es exacto.
- **Segmento**: un filtro vivo con la gramática común de condiciones (`server/lib/conditions.mjs`, forma canónica `{version, match, groups:[{match, rules}]}`). Se recalcula al crearlo, editarlo, abrirlo o pulsar «Recalcular».
- **Lista de exclusión** (`role: 'suppression'`, sólo listas): sus miembros nunca reciben difusiones de la marca. Convive, sin mezclarse, con el consentimiento, los bloqueos de Meta y las supresiones de privacidad.
- **Prediseñados** (se crean en cada marca la primera vez que se listan; no se editan, sí se duplican y archivan): Todos con teléfono válido, Para recuperar (último mensaje hace 30 a 90 días), En riesgo (más de 90 días o nunca), Con pago pendiente, Interesados sin inscribirse, Alumnos inscritos. «Muy activos» queda para cuando existan los resultados de difusiones con plantilla (D-5).

## Datos

`audiences` (marca, `kind` list|segment, `role`, nombre y clave sin acentos, descripción, `definition`, `preset`, `source`/`source_ref`, `member_count`/`counted_at`, `status`, `revision`, `client_ref`, `archived_at`) y `audience_members` (lista, contacto, origen, quién y cuándo; registrada en `host.personData`: una fusión mueve las membresías sin duplicar y recuenta). Sin `CHECK` en tipos y estados. El nombre es único entre las audiencias activas de la marca (uno archivado se puede reutilizar).

## Campos de un segmento

Los de la lista de contactos (`server/modules/directory/repo.mjs`, salvo «marca»), con etiquetas y cursos cerrados a los de la marca, más: `phone` (dígitos), `list` (está o no en una lista de la marca; sólo listas, sin ciclos), `last_inbound` (último mensaje del contacto), `channel`, `enrolled`, `enrolled_course`, `pending_order` y la familia `attr` de los datos de contacto (`attributes.conditionFields`). Todo valor viaja como parámetro; las pruebas comprueban que SQL y memoria dan el mismo resultado sobre 6 500 contactos.

**Privacidad.** Quien no tiene `contacts.phone` no puede filtrar por el contenido del teléfono, del correo (sí por «tiene» o «no tiene») ni de un dato personal: 403 `permission_denied`. Tampoco se le ofrecen esos campos y los teléfonos de la vista previa le llegan enmascarados.

## Quién entra y quién no

Cada contacto seleccionado recibe el primer motivo que cumple: `excluded` (lo quitó quien arma la difusión), `no_phone`, `suppressed` (lista de exclusión), `opted_out` (baja), `no_consent` (sin consentimiento para promociones; se puede desactivar con `requireConsent: false`) y `duplicate` (otro miembro con el mismo teléfono, id menor y sin otro motivo, ya entra). Sin motivo = puede recibir.

## Rutas (`/api/audiences`; ver `campaigns.view`, editar `audiences.edit`)

`GET ?brand=&archived=1` · `GET /fields?brand=` (campos para el constructor del kit) · `POST` `{brandId, kind, name, description?, role?, definition?, contactIds?, fromAudienceId?, clientRef}` · `GET|PATCH /:id` (`expectedRevision`) · `POST /:id/duplicate|archive|restore|recount` · `POST /preview` `{brandId, definition | audienceId | spec, requireConsent?}` → `{total, eligible, excluded:[{reason,label,count}], sample, ms}` (60 por minuto) · `GET /:id/members?status=all|eligible|excluded&reason=&cursor=&limit=` (orden por nombre e id; `summary` en la primera página) · `POST /:id/members` `{add?, remove?}` (≤500, idempotente). Archivar o pasar a exclusión una audiencia que usa una campaña programada, enviando, en pausa o detenida responde 409 `audience_in_use` con las campañas. Topes: 200 listas y 50 segmentos propios activos por marca, 50 000 miembros por lista.

## Para otros módulos (`host.module('audiences')`)

- `addContacts(brandId, audienceId, contactIds, {source, sourceRef, actorId}) → {added, refused}`: componible (sin transacción propia), idempotente; ignora contactos de otra marca.
- Motor de difusiones (D-5): `members(brandId, spec, {after, limit, status, requireConsent}) → {rows:[{contactId, name, phone, phoneKey, personaId, consent, reason}], next}` por id (estable, sin repetidos); `summary(brandId, spec)`; `selectSql(brandId, spec)` y `memberSql(brandId, audienceId, {alias})` (predicado `<alias>.id IN (…)`). `spec` = `{audienceId}`, `{definition}` o `{version:2, include:[{audienceId}|{all:true}|{definition}], exclude:[{audienceId}]}` (hasta 5 de cada uno).
- Importación (fila 14, un solo importador): en el mapeo, `options.list = {audienceId}` o `{name}`; la lista nueva se crea al lanzar la importación (idempotente por la importación) y cada trozo añade, en su transacción, a los creados, actualizados y sin cambios. El informe trae `list: {audienceId, name, memberCount}`. El asistente «Importar contactos» tiene la sección «Añadir a una lista».
- Campañas de catálogo: `segment.audienceId` toma una audiencia como público (se combina con los filtros de siempre) y las listas de exclusión se restan siempre (motivo `suppressed`). El público por catálogo no cambia.

## Pantalla

`public/screens/audiencias/` (grupo Gestión, icono `users-round`, administración y asesor con `campaigns.view`; hoy sólo administración lo tiene): audiencias de la marca con su conteo, nuevo segmento con el constructor de condiciones y el conteo en vivo con los excluidos por motivo, nueva lista (o de exclusión), ver miembros por páginas con su estado, archivar y restaurar. Prueba: `test/ui/audiencias.spec.mjs`.

## Medido (pruebas, 6 500 contactos, servidor real)

Vista previa de toda la marca ≈ 50 ms; recontar ≈ 20 ms; recorrer los 6 500 de 50 en 50 por HTTP (130 páginas) ≈ 2,3 s. La prueba admite 5 s por operación.

## Fuera de este incremento

Motor y asistente de difusiones (D-5), campos de resultados de campañas (`campaign`, `campaign_count`, `ad`) y el prediseñado «Muy activos», `fromCampaign`, exportar miembros a CSV, buscar dentro de los miembros, añadir a una lista desde la lista de contactos, editar las condiciones de un segmento desde la pantalla (la API ya lo permite) y avisos en vivo de progreso de importación por audiencia (la importación ya los emite como trabajo).
