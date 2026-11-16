// Vistas guardadas de la bandeja (docs/PLAN_BANDEJA_VISTAS.md; diseño de bandeja §3.3, migración M-C «vistas-bandeja»;
// conciliación fila 1: las migraciones de la bandeja van en el área `conversations`, porque `inbox` es de la bandeja
// de webhooks).
//
//   inbox_views   una vista guardada: nombre, vista del sistema de partida (`base`), filtro con la gramática común
//                 (server/lib/conditions.mjs), orden y a quién se muestra:
//                   visibility 'me'   sólo a su dueño (ni administración la ve)
//                   visibility 'all'  a todo el equipo con acceso a su marca (`brand_id` obligatorio; compartir exige
//                                     el permiso `inbox.views.share` en esa marca)
//                 `brand_id` NULL en una vista personal: se aplica a todas las marcas de quien la abre.
//                 `client_ref` (único por dueño) hace que reintentar la creación no la duplique; `last_ref` hace lo
//                 mismo con un cambio (PATCH). Borrar es archivar (`archived_at`).
//
// Sin CHECK sobre `visibility`, `base` ni `sort`: son listas que otros incrementos amplían (equipos, «seleccionadas»,
// vistas nuevas) y se validan en código (conciliación, regla de la sección A).
// Lo que el diseño pone también en M-C y aquí NO va: `inbox_view_shares` (compartir con personas elegidas),
// `conversation_stars` (favoritas) y `preferences.settings` (orden y vistas ocultas por persona). Llegan con su
// incremento, con otra migración.
export default {
  name: 'conversations/0001-inbox-views',
  after: [], // users y brands son de la escalera
  up(db) {
    db.exec(`
      CREATE TABLE inbox_views(
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id),
        brand_id TEXT REFERENCES brands(id),
        name TEXT NOT NULL,
        base TEXT NOT NULL DEFAULT 'all',
        filter TEXT NOT NULL DEFAULT '{"version":1,"match":"any","groups":[]}',
        sort TEXT NOT NULL DEFAULT 'recent',
        visibility TEXT NOT NULL DEFAULT 'me',
        revision INTEGER NOT NULL DEFAULT 1,
        client_ref TEXT,
        last_ref TEXT,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT REFERENCES users(id)
      );
      CREATE UNIQUE INDEX inbox_views_client_ref ON inbox_views(owner_id, client_ref) WHERE client_ref IS NOT NULL;
      CREATE INDEX inbox_views_owner ON inbox_views(owner_id, created_at) WHERE archived_at IS NULL;
      CREATE INDEX inbox_views_shared ON inbox_views(brand_id, created_at) WHERE archived_at IS NULL AND visibility != 'me';
    `);
  },
};
