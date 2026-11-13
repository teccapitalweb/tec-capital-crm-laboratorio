import { transaction } from './database.mjs';

// Esquema v25 (Fase 2 · bloque 2.8, puente con IPCIL). Históricos del panel actual (Firebase) importados por archivo
// JSON o CSV, sólo lectura: cursos, aperturas, alumnos (inscripciones históricas), ventas (pagos registrados) y
// certificados. Cada registro queda ligado a la persona del CRM (contacto en la marca + identidad única) y se enseña en
// la ficha de persona y en Finanzas como histórico; nunca entra al libro de ventas ni devenga comisiones. Idempotente por
// (marca, tipo, id externo); una importación completa es un lote que se puede quitar.
export function migrateLegacy(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 25) return;
  transaction(db, () =>
    db.exec(`
    CREATE TABLE legacy_batches(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),source TEXT NOT NULL,format TEXT NOT NULL,filename TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',counts TEXT NOT NULL DEFAULT '{}',imported_by TEXT REFERENCES users(id),imported_at INTEGER NOT NULL);
    CREATE TABLE legacy_records(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES legacy_batches(id),brand_id TEXT NOT NULL REFERENCES brands(id),kind TEXT NOT NULL CHECK(kind IN ('curso','apertura','alumno','venta','certificado')),external_id TEXT NOT NULL,person_id TEXT REFERENCES persons(id),contact_id TEXT REFERENCES contacts(id),title TEXT NOT NULL DEFAULT '',amount_cents INTEGER,currency TEXT NOT NULL DEFAULT 'MXN',occurred_at INTEGER,status TEXT NOT NULL DEFAULT '',folio TEXT,data TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,UNIQUE(brand_id,kind,external_id));
    CREATE INDEX legacy_records_person ON legacy_records(person_id,kind,occurred_at);
    CREATE INDEX legacy_records_brand ON legacy_records(brand_id,kind,occurred_at);
    CREATE INDEX legacy_records_batch ON legacy_records(batch_id);
    PRAGMA user_version=25;
  `),
  );
}
