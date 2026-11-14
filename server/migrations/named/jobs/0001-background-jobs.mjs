// Trabajos largos por trozos (docs/PLAN_IMPORTAR_CONTACTOS.md; conciliación técnica, fila 5): importaciones y, después,
// ediciones en lote, acciones masivas y rellenos. Es la cola (c) de las cuatro que fija la conciliación; el ejecutor
// está en server/lib/background-jobs.mjs y su reloj en el módulo server/modules/jobs/.
//
//   background_jobs   una fila por trabajo. `kind` SIN restricción en la tabla (la lista vive en código: cada módulo
//                     declara los suyos). `ref_id` señala lo que el trabajo procesa (una importación…). `cursor` es
//                     dónde sigue tras un reinicio; `done` y `total`, el progreso. `lease_owner`/`lease_until`: quién
//                     trabaja el trozo en curso y hasta cuándo (mismo patrón de reclamo que server/app/leases.mjs).
//                     `cancel_requested`: se detiene entre trozos. `client_ref`: un reintento no crea otro trabajo.
export default {
  name: 'jobs/0001-background-jobs',
  after: [],
  up(db) {
    db.exec(`
      CREATE TABLE background_jobs(
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        brand_id TEXT REFERENCES brands(id),
        created_by TEXT REFERENCES users(id),
        ref_id TEXT,
        state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','failed','cancelled')),
        total INTEGER NOT NULL DEFAULT 0,
        done INTEGER NOT NULL DEFAULT 0,
        cursor TEXT,
        params TEXT NOT NULL DEFAULT '{}',
        result TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until INTEGER,
        client_ref TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX background_jobs_due ON background_jobs(created_at) WHERE state IN ('queued','running');
      CREATE INDEX background_jobs_ref ON background_jobs(ref_id, created_at) WHERE ref_id IS NOT NULL;
    `);
  },
};
