# Guía para añadir módulos, pantallas y cambios de esquema

Desde noviembre de 2026 lo nuevo se construye **sin tocar los archivos compartidos** (`server/index.mjs`, `public/index.html`, `public/app.js`, la escalera de migraciones). Así varios frentes pueden trabajar a la vez y cada entrega se revisa sola. Esta guía es el contrato; el código que lo hace cumplir está en `server/app/` y `server/migrations/`, y sus pruebas en `test/modules.test.mjs`, `test/screens.test.mjs`, `test/static.test.mjs` y `test/migrations.test.mjs`.

Lo que ya existía (los módulos de la raíz de `server/` y los guiones de la raíz de `public/`) sigue igual y se sigue manteniendo donde está.

## 1. Un cambio de esquema: migración con nombre

La escalera `PRAGMA user_version` está **cerrada en la 41**. No se añade ninguna función `migrateX` ni se cambia `user_version` (hay una prueba que lo impide). Todo cambio nuevo es un archivo:

```text
server/migrations/named/<área>/<NNNN>-<descripción>.mjs     una migración
server/migrations/named/<área>/index.mjs                    la lista ordenada del área
server/migrations/registry.mjs                              una línea por área
```

```js
// server/migrations/named/contacts/0001-attributes.mjs
import { addColumn } from '../../named.mjs';

export default {
  name: 'contacts/0001-attributes', // igual que la ruta, sin extensión
  after: [], // nombres de migraciones de OTRA área que deben existir antes
  up(db) {
    db.exec(`CREATE TABLE contact_attributes(
      id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id), key TEXT NOT NULL, label TEXT NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE(brand_id, key));`);
    addColumn(db, 'contacts', 'attributes', "TEXT NOT NULL DEFAULT '{}'");
  },
};
```

```js
// server/migrations/named/contacts/index.mjs
import m0001 from './0001-attributes.mjs';
export default [m0001];
```

```js
// server/migrations/registry.mjs
import contacts from './named/contacts/index.mjs';
export const NAMED = defineRegistry([...contacts]);
```

Reglas del cuerpo `up(db)`:

- Síncrono. Sin `BEGIN`/`COMMIT` (los pone el ejecutor), sin `PRAGMA user_version`, sin red ni archivos.
- **Aditivo**: tablas, índices y columnas con `DEFAULT` o que admiten `NULL` (con `addColumn`, que no repite una columna). Así el código anterior sigue funcionando si hay que revertir un despliegue.
- Tablas y disparadores se crean **sin** `IF NOT EXISTS`: el ejecutor garantiza una sola pasada y dos migraciones que crean el mismo objeto fallan en lugar de callar.
- Sólo toca tablas de su área; si necesita una de otra, lo declara en `after`.
- Rellenos de datos acotados. Uno grande va en un trabajo por trozos, no en la migración.
- Publicada en `main`, **no se modifica**: un error se corrige con otra migración.
- Reconstruir una tabla (cambiar una restricción, quitar una columna) exige `rebuild: true` y el ayudante `rebuildTable`, que conserva filas, índices, disparadores, vistas y el contador de `AUTOINCREMENT`; va siempre con una prueba de actualización sobre una base con datos.

Cada migración se aplica una vez, en su propia transacción, y queda anotada en `schema_migrations`. Antes de aplicar algo pendiente a una base con usuarios se guarda una copia en `backups/before-<nombre>-<ms>.sqlite`. La identidad del esquema es `41` sin migraciones con nombre y `41+N.<huella>` con N; la imprime `npm run schema:id` y la devuelve `/api/health` en `schema`.

En las pruebas no se afirma un número de esquema: se usa `assertSchemaCurrent(db)` de `test/helpers/schema.mjs`.

## 2. Un módulo del servidor

```text
server/modules/<nombre>/module.mjs     descriptor y rutas
server/modules/<nombre>/repo.mjs       todo el SQL del módulo
server/lib/                            bibliotecas sin rutas (condiciones, variables, CSV, claves de identidad…)
```

```js
// server/modules/broadcasts/module.mjs
import { createRepo } from './repo.mjs';

export default {
  name: 'broadcasts', // igual que la carpeta
  // prefixes: ['/api/broadcasts'],  // opcional; por omisión /api/<name>
  create(host) {
    const repo = createRepo(host.db);
    return {
      async handle(req, res, path, user, url) {
        host.requireStaff(user);
        if (req.method === 'GET' && path === '/api/broadcasts') {
          const brandId = url.searchParams.get('brand');
          host.services.crm.requireBrand(user, brandId);
          host.json(res, 200, { broadcasts: repo.list(brandId) });
          return true;
        }
        return false; // no es mía: el servidor responde 404 «Ruta no disponible.»
      },
      tick() {},
    };
  },
  // public: { prefixes: ['/api/compat/x'], handle: (api, req, res, path, url, ip) => api.handlePublic(req, res, path, url, ip) },
  timers: [{ name: 'envio', everyMs: 1000, testEveryMs: 200, run: api => api.tick() }],
};
```

El servidor descubre cada carpeta al arrancar, crea el módulo **después** de los servicios actuales y lo monta **después** de sus rutas. No hay que editar `server/index.mjs`.

- **Rutas.** Todas viven bajo los prefijos del módulo. Un prefijo no puede pisar una ruta del servidor actual (lista `RESERVED` de `server/app/modules.mjs`), ni la de otro módulo, y el módulo no puede llamarse como un servicio actual (`crm`, `contacts`, `campaigns`, `flows`…). `handle` devuelve `true` si atendió y `false` si la ruta no es suya.
- **Sesión.** `handle` sólo se llama con sesión válida y, en escrituras, con el `Origin` ya comprobado. Las rutas de `public` se atienden **sin** sesión ni `Origin`: el módulo responde de su propia llave o firma y de su límite por IP (`host.rate`).
- **Alcance por marca.** Lo impone el módulo en cada consulta (`host.services.crm.requireBrand(user, brandId)`, `canBrand`). Las funciones de `repo.mjs` reciben `brandId` como primer parámetro. Una marca autorizada no equivale a acceso a toda la empresa.
- **`host`** presta: `db`, `transaction`, `fail(status, mensaje, { code, field, details })`, `access` (permisos: `host.access.require(user, 'contacts.view', brandId)`, `can`, `brandIds`, `scopeSql`, `phone`), `realtime` (`host.realtime.emit('tipo.propio', { brandId, data })`: aviso en vivo sólo a quien puede ver esa marca o conversación), `personData` (registro de tablas ligadas a la persona: toda tabla nueva con `contact_id` o `person_id` se declara con `host.personData.register(…)`; ver [PLAN_FUSION_Y_DATOS_DE_PERSONA.md](PLAN_FUSION_Y_DATOS_DE_PERSONA.md)), `clean`, `json`, `body`, `audit`, `rate`, `broadcast`, `online`, `staff`, `requireStaff`, `requireAdmin`, `accessConversation`, `canSee`, `insertMessage`, `takeOver`, `root`, `dataDir`, `version`, `production`, `selfOrigin()`, los servicios actuales en `host.services` (`crm`, `events`, `persons`, `catalogue`, `contacts`, `channel`, `payments`, `replies`, `automation`, `campaigns`, `whatsapp`…) y `host.module('otro')` para hablar con otro módulo nuevo (se resuelve al usarlo, no al crear).
- **Transacciones.** `transaction(db, fn)` es síncrona y no se anida; nada de red dentro. Varias funciones de los servicios actuales abren la suya (`setContactTags`, `setConsent`, `automation.enqueue`): no se llaman desde dentro de otra transacción.
- **Idempotencia.** Toda escritura acepta `clientRef` y, si edita algo con revisión, `expectedRevision`. Un reintento no duplica mensajes, tareas ni cambios de negocio.
- **Relojes.** Se declaran en `timers`. Un reloj no se pisa a sí mismo, trabaja por trozos (con tope de filas por pasada) y corre como mucho una vez por segundo, salvo que declare `fast: true` (mínimo 250 ms) y lo justifique.
- **Permisos.** Las claves están en `server/lib/permissions.mjs` (en inglés: `contacts.view`, `campaigns.send`…). `host.access.require` responde 403 si falta el permiso y 404 si la marca no es de esa persona. Hoy hay dos conjuntos fijos: administración lo tiene todo y asesor conserva lo de siempre. Detalle en [PLAN_ACCESO_TIEMPO_REAL.md](PLAN_ACCESO_TIEMPO_REAL.md).
- **Registros.** Un módulo declara sus tipos de evento con `host.services.events.registerTypes(…)`, lo que necesita un webhook con `host.services.integrations.registerNeeds(…)` y sus pasos de «Preparar marca» con `host.services.readiness.register(…)`, sin editar esos archivos.
- **Errores.** `throw host.fail(409, 'Mensaje claro en español.', { code: 'stale_record' })`; `code` va en minúsculas con guion bajo. Lo que no lleva `status` responde 500 con un texto fijo y se registra.
- **Apagado por omisión.** Lo que envía mensajes, cobra o cambia datos de clientes nace apagado o acotado por marca hasta que administración lo active.

Un módulo que no carga no detiene al servidor: se omite, se registra y `/api/health` lo lista en `modulesFailed`. En las pruebas, en cambio, es un error.

Pruebas: las de lógica llaman a las funciones del módulo con una base temporal (`openDatabase` + `migrate(db, { backup: false })`); las de punta a punta arrancan el servidor real con `startServer({ dir })` de `test/helpers/server.mjs`.

## 3. Una pantalla

```text
public/screens/<id>/screen.json
public/screens/<id>/index.js
public/screens/<id>/screen.css        opcional
```

```json
{
  "id": "difusiones",
  "title": "Difusiones",
  "visibility": "preview",
  "nav": { "group": "Gestión", "icon": "megaphone", "label": "Difusiones", "order": 40 },
  "roles": ["admin", "agent"],
  "entry": "index.js",
  "styles": ["screen.css"]
}
```

- El servidor publica la lista en `GET /screens/index.json` y sirve los archivos de la carpeta tal cual (módulos ES del mismo origen; la política de contenido no admite guiones en línea ni de terceros). No se edita `index.html` ni `app.js`.
- `id`: de 3 a 31 caracteres en minúsculas; no puede repetir una vista actual (`inbox`, `contacts`, `team`, `settings`, `analytics`, `operations`…).
- **`visibility`**: `"preview"` (por omisión) sólo aparece con `SCREENS_PREVIEW=1`, que se usa al desarrollar y en las pruebas; `"live"` aparece siempre. Una pantalla puede estar en `main` sin verse en producción hasta que se decide publicarla.
- `nav` es opcional (sin él la pantalla no sale en el menú); `permission` es opcional (clave del catálogo de permisos, además de `roles`). La lista no es un secreto: el permiso real lo impone cada API.
- Una carpeta sin `screen.json` todavía no es una pantalla y se ignora.
- El contrato de `index.js` (`mount(root, ctx)`, `onEvent`), el kit (`public/kit/`), las variables de diseño (`public/tokens.css`) y cómo empezar una pantalla copiando `public/screens/ejemplo/` están en [GUIA_PANTALLAS.md](GUIA_PANTALLAS.md). Las reglas de Niebla que toda pantalla debe cumplir, en [DISENO_Y_AUDITORIA.md](DISENO_Y_AUDITORIA.md).

Los archivos estáticos se sirven por carpeta: cualquier archivo de `public/` con ruta en minúsculas y extensión `.js`, `.css`, `.svg`, `.png`, `.webmanifest`, `.json` o `.woff2`, salvo `flyers/` (se sirven con sesión) y la portada por su nombre. Llevan `Cache-Control: no-cache` y `ETag`: el navegador pregunta siempre y, tras un despliegue, la primera carga ya trae el código nuevo.

## 4. Antes de entregar

```sh
npm run check     # codificación, sintaxis, reglas (ESLint) y formato (Prettier)
npm test
npm run test:ui   # pruebas de humo en un navegador real, en computadora y en celular
```

- Archivos en UTF-8, finales de línea LF, formato de Prettier (`npx prettier --write <archivos>`).
- Cada módulo, pantalla y migración llega con sus pruebas. Una pantalla trae su `test/ui/<pantalla>.spec.mjs`, que la monta en los dos tamaños (proyectos `escritorio` y `celular`), comprueba que no deja errores con `watch(page)` y llama a `expectNiebla(page, nombre, testInfo)` (letra de 11 px o más, contraste, áreas táctiles de 40 px y sin desborde; una pantalla nueva no tiene línea base: su límite es cero). Ayudantes en `test/ui/helpers.mjs`.
- No se suben secretos, datos de clientes, copias de la base ni adjuntos. El repositorio es público.
