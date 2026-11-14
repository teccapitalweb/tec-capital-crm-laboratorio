# Plan: acceso, tiempo real v2 y errores (incremento X1)

Estado: **construido en la rama de integración, sin publicar**. Sin esquema nuevo, sin cambio de versión y sin nada visible: es la base común que usarán los módulos nuevos (contactos, difusiones, API). Hasta que un módulo la use, el CRM se comporta igual que antes.

## Qué se construyó

| Pieza | Archivo | Qué da |
| --- | --- | --- |
| Catálogo de permisos | `server/lib/permissions.mjs` | 70 claves en inglés con etiqueta y grupo en español, y los dos conjuntos fijos de hoy |
| Acceso | `server/lib/access.mjs` → `host.access` | `can`, `require`, `brandIds`, `scopeSql`, `phone` |
| Errores | `server/app/http.mjs` → `host.fail` | `fail(status, mensaje, { code, field, details })` y el cuerpo único de error |
| Tiempo real v2 | `server/app/realtime.mjs` → `host.realtime` | `emit(tipo, { brandId, conversationId, data })` |
| Registros por función | `server/events.mjs`, `integrations.mjs`, `readiness.mjs` | `registerTypes`, `registerNeeds`, `register`: lo nuevo no edita esas listas |

Pruebas: `test/access.test.mjs`, `test/realtime.test.mjs`, `test/http-fail.test.mjs` y `test/registries.test.mjs`.

## Permisos

No hay tablas de roles todavía (llegan con el diseño de equipo). Mientras tanto hay dos conjuntos fijos por `users.role`: **administración lo tiene todo** y **un asesor conserva exactamente lo que hoy puede hacer** en sus marcas. Un cliente no tiene ninguno. Las rutas actuales siguen con sus comprobaciones de siempre; las rutas nuevas preguntan al catálogo desde el primer día, de modo que cuando existan los roles nadie gana ni pierde nada.

| Grupo | Claves (en **negrita**, las que tiene el asesor) |
| --- | --- |
| Bandeja | **`inbox.view`**, **`inbox.reply`**, **`inbox.note`**, **`inbox.take`**, **`inbox.resolve`**, **`inbox.assistant`**, **`inbox.priority`**, **`inbox.block`**, `inbox.assign`, `inbox.manage_others`, `inbox.bulk`, `inbox.start`, `inbox.unblock`, `inbox.export`, `inbox.views.share` |
| Contactos | **`contacts.view`**, **`contacts.phone`**, **`contacts.create`**, **`contacts.edit`**, **`contacts.tags.apply`**, **`contacts.consent`**, `contacts.tags.manage`, `contacts.consent.reactivate`, `contacts.merge`, `contacts.archive`, `contacts.erase`, `contacts.import`, `contacts.export`, `contacts.bulk`, `contacts.attributes.manage` |
| Ventas | **`sales.opportunities`**, **`sales.charge`** |
| Equipo | **`team.view`**, `team.manage`, `team.roles`, `team.availability`, `team.sessions` |
| Ajustes | `settings.hours`, `settings.routing`, `settings.inbox`, `settings.quickreplies`, `settings.library`, `settings.costs` |
| Seguridad | `security.manage`, `audit.view`, `audit.export` |
| Difusiones | `campaigns.view`, `campaigns.edit`, `campaigns.send`, `campaigns.export`, `audiences.edit` |
| Automatización | `automation.manage` |
| Estadísticas | `analytics.view`, `analytics.export`, `cx.review` |
| Canales | `channels.whatsapp.connect`, `templates.manage`, `connections.manage` |
| Desarrolladores | `developer.keys.manage` |
| Privacidad | `privacy.person.export`, `privacy.person.erase` |
| Empresa | `company.profile.edit`, `company.users.manage`, `company.sso.configure`, `company.security.policies`, `company.data.export`, `company.data.delete`, `company.usage.view`, `company.support.authorize`, `backups.view` |

Una clave publicada no cambia de nombre. Cada frente añade las suyas en su espacio de nombres, en `permissions.mjs`.

### `host.access`

| Función | Qué hace |
| --- | --- |
| `can(user, perm, scope?)` | `true` o `false`. Un permiso que no está en el catálogo lanza un error (es un fallo de quien programa) |
| `require(user, perm, scope?)` | No devuelve nada si puede. Si no es del equipo o le falta el permiso: **403** `permission_denied`. Si lo tiene pero la marca no es suya, no existe o no viene: el **404** de siempre, `not_found` («Marca o registro no disponible.») |
| `brandIds(user, perm?)` | Marcas de la persona, en orden de creación |
| `scopeSql(user, alias)` | `{ sql, args }` para acotar una consulta: `c.brand_id IN (?,?)`; sin marcas, `0=1` |
| `phone(user, valor, scope?)` | El teléfono completo para quien tiene `contacts.phone`; para los demás, enmascarado en el servidor (`+525 ••••• 5678`) |

`scope` es **la marca** (su id) o **`{ company: true }`** (toda la empresa: hoy sólo administración). Sin `scope` significa «en alguna de sus marcas» y sirve para decidir si una pantalla se le muestra a alguien. Cualquier otra cosa (`null`, texto vacío) se niega, también a administración: un parámetro `brand` que falta en la petición nunca se convierte en «todas las marcas». Una marca autorizada no da acceso a ninguna otra. El rol y las marcas se leen de la base en cada pregunta, así que un acceso retirado deja de valer en el acto.

## Errores

`fail(status, mensaje, { code, field, details })` es el único constructor para el código nuevo, y toda respuesta de error tiene la misma forma:

```json
{ "error": "Otra persona cambió este contacto. Vuelve a abrirlo.", "code": "stale_record", "field": "phone", "details": { "revision": 4 } }
```

`error` va siempre; `code`, `field` y `details` sólo si se declaran. `code` va en **minúsculas con guion bajo** y es estable (el texto puede cambiar de redacción); uno mal escrito lanza un `TypeError` al momento. `details` no lleva secretos, datos personales ni texto de mensajes. Lo que ya existía no cambia: los textos son los mismos, y los dos códigos antiguos del seguimiento (`STALE_RECORD`, `ACTIVE_INTEREST` con `activeOpportunityId`) se devuelven como siempre. Un fallo inesperado sigue respondiendo 500 con un texto fijo.

## Tiempo real v2

Los avisos de siempre (`conversation`, `crm`, `catalog`, `presence`, `read`, `typing`) no cambian y la interfaz actual sigue recargando con ellos. Lo nuevo viaja por el mismo WebSocket en un sobre con versión:

```json
{ "v": 2, "type": "campaign.progress", "at": 1767225600000, "brandId": "globalvet", "conversationId": null, "data": { "sent": 120, "total": 400 } }
```

- `emit(tipo, { brandId, conversationId, data })` devuelve a cuántos sockets llegó. El tipo va en minúsculas con puntos y `data` es un objeto breve.
- **A quién llega:** con `brandId`, al equipo con acceso a esa marca (nunca a un cliente); con `conversationId`, al equipo que puede ver esa conversación. Sin marca ni conversación válidas, a nadie. El acceso se decide al emitir, leyendo la base.
- **La persona que escribe** no recibe los sobres v2 de su conversación salvo que el módulo lo pida con `includeCustomer: true`. Un aviso de siempre no lleva datos; un sobre v2 sí, y ella podría leerlos en su navegador. Con esa opción, `data` no puede traer nada interno (notas, responsable, etiquetas).
- Se emite **después** de confirmar la transacción.
- La interfaz actual (`public/app.js`) **ignora** los sobres v2 en lugar de recargarlo todo, y se los pasa a `window.TC.screens.notify(sobre)` cuando exista el registro de pantallas.

## Registros por función

```js
events.registerTypes(
  { 'difusion.enviada': { title: 'Difusión enviada', entity: 'campaign', payload: 'name, recipients' } },
  { entities: { campaign: 'Difusión' } }, // sólo si el tipo estrena una entidad
);
integrations.registerNeeds({ 'difusion.enviada': 'contacts' }); // permiso de la llave que deja leer su contenido
readiness.register({
  id: 'audiencia', group: 'Extras', title: 'Tiene una audiencia lista', required: false,
  view: 'difusiones', label: 'Ir a Difusiones',
  check: brand => ({ done: total(brand.id) > 0, detail: 'Sin audiencias no hay a quién enviar.' }), // síncrona, sólo lee
});
```

Los tres rechazan lo repetido y lo mal formado, son todo o nada y viven por instancia (las listas escritas en esos archivos no cambian). Un tipo registrado es un evento de dominio como los demás: se publica, se entrega y se consulta igual, y **quien ya recibía todos los tipos (el núcleo compartido y los webhooks salientes) lo recibe también**, así que su carga sigue las mismas reglas: breve, sin secretos ni texto de mensajes. Mientras un tipo no tenga su permiso con `registerNeeds`, la API de lectura lo entrega sin datos. Un paso de «Preparar marca» cuya función falla queda pendiente y no tumba la lista.

## Cómo lo usa un módulo

```js
// server/modules/broadcasts/module.mjs
export default {
  name: 'broadcasts',
  create(host) {
    const { events, integrations } = host.services;
    events.registerTypes({ 'difusion.enviada': { title: 'Difusión enviada', entity: 'campaign' } }, { entities: { campaign: 'Difusión' } });
    integrations.registerNeeds({ 'difusion.enviada': 'contacts' });
    return {
      async handle(req, res, path, user, url) {
        const brandId = url.searchParams.get('brand');
        if (req.method === 'GET' && path === '/api/broadcasts') {
          host.access.require(user, 'campaigns.view', brandId); // 403 o 404
          host.json(res, 200, { broadcasts: repo.list(brandId) });
          return true;
        }
        if (req.method === 'POST' && path === '/api/broadcasts/send') {
          host.access.require(user, 'campaigns.send', brandId);
          const input = await host.body(req);
          const sent = host.transaction(host.db, () => repo.send(brandId, input)); // lanza host.fail(409, …, { code: 'stale_record' })
          host.realtime.emit('campaign.progress', { brandId, data: { id: sent.id, sent: 0, total: sent.total } });
          host.json(res, 202, { id: sent.id });
          return true;
        }
        return false;
      },
    };
  },
};
```

## Límites y lo que falta

- **Sin roles ni tablas.** `roles`, `role_permissions`, la visibilidad por equipo o propia, el contexto en memoria y `access.bump()` llegan con el diseño de equipo. La correspondencia entre los permisos de las llaves de la API y estas claves la añade quien construya la API de escritura.
- **Las rutas actuales no cambiaron** a `access.require`: se migran módulo a módulo.
- **Tiempo real:** no hay entrega a una sola persona (`notification.new`, «a quien lanzó el trabajo») ni `watch`/`unwatch`; llegan con la bandeja nueva.
- **Orden de carga:** los módulos se crean en orden alfabético. Uno que se suscriba a un tipo que registra otro módulo posterior lo encontrará sin registrar; el tipo compartido lo declara el que carga primero.
- `docs/GUIA_MODULOS.md` todavía no menciona `host.access`, `host.realtime` ni el tercer parámetro de `fail`: se añade al integrar.
