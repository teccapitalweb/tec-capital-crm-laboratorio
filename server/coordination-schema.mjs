import { transaction } from './database.mjs';

// Esquema v19 (Fase 2 · bloques 2.1 y 2.3).
// - domain_events: índice común de hechos del negocio (un registro por hecho, idempotente por dedupe_key). Las tablas de
//   detalle de cada módulo (payment_events, channel_events, crm_events…) siguen siendo la fuente de su módulo; aquí sólo
//   queda la referencia y una carga breve. domain_deliveries: entregas a suscriptores en proceso, con reintento.
// - Coordinación académica sobre la edición existente: campos de apertura (mínimo, estado operativo, responsable, grupo),
//   sesiones con enlace de videollamada, asistencia por inscripción y recursos (materiales, grabaciones, enlaces).
//   La tabla de sesiones se llama edition_sessions porque `sessions` ya es la tabla de accesos.
export function migrateCoordination(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 19) return;
  transaction(db, () =>
    db.exec(`
    CREATE TABLE domain_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,type TEXT NOT NULL,brand_id TEXT NOT NULL REFERENCES brands(id),entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,payload TEXT NOT NULL DEFAULT '{}',actor_id TEXT REFERENCES users(id),source TEXT NOT NULL,dedupe_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);
    CREATE INDEX domain_events_brand ON domain_events(brand_id,seq);
    CREATE INDEX domain_events_type ON domain_events(type,seq);
    CREATE INDEX domain_events_entity ON domain_events(entity_kind,entity_id,seq);
    CREATE TABLE domain_deliveries(event_seq INTEGER NOT NULL REFERENCES domain_events(seq),subscriber TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','done','failed')),attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,error TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(event_seq,subscriber));
    CREATE INDEX domain_deliveries_due ON domain_deliveries(state,next_attempt_at);
    ALTER TABLE editions ADD COLUMN min_students INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE editions ADD COLUMN run_status TEXT NOT NULL DEFAULT 'planned' CHECK(run_status IN ('planned','open','running','closed','cancelled'));
    ALTER TABLE editions ADD COLUMN coordinator_id TEXT REFERENCES users(id);
    ALTER TABLE editions ADD COLUMN group_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE editions ADD COLUMN run_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE editions ADD COLUMN run_revision INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE editions ADD COLUMN run_updated_at INTEGER;
    ALTER TABLE enrollments ADD COLUMN cancelled_at INTEGER;
    ALTER TABLE enrollments ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';
    CREATE TABLE coordination_settings(brand_id TEXT PRIMARY KEY REFERENCES brands(id),enabled INTEGER NOT NULL DEFAULT 0,auto_open INTEGER NOT NULL DEFAULT 1,reminder_hours INTEGER NOT NULL DEFAULT 24,revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT REFERENCES users(id),updated_at INTEGER NOT NULL);
    CREATE TABLE edition_sessions(id TEXT PRIMARY KEY,edition_id TEXT NOT NULL REFERENCES editions(id),brand_id TEXT NOT NULL REFERENCES brands(id),number INTEGER NOT NULL,title TEXT NOT NULL,starts_at INTEGER NOT NULL,duration_min INTEGER NOT NULL DEFAULT 90,meet_url TEXT NOT NULL DEFAULT '',meet_provider TEXT NOT NULL DEFAULT 'none',recording_url TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN ('scheduled','done','cancelled')),reminder_sent_at INTEGER,revision INTEGER NOT NULL DEFAULT 1,created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX edition_sessions_edition ON edition_sessions(edition_id,starts_at);
    CREATE INDEX edition_sessions_due ON edition_sessions(status,starts_at);
    CREATE TABLE attendance(session_id TEXT NOT NULL REFERENCES edition_sessions(id),enrollment_id TEXT NOT NULL REFERENCES enrollments(id),status TEXT NOT NULL CHECK(status IN ('present','absent','late','excused')),note TEXT NOT NULL DEFAULT '',marked_by TEXT REFERENCES users(id),marked_at INTEGER NOT NULL,PRIMARY KEY(session_id,enrollment_id));
    CREATE TABLE edition_resources(id TEXT PRIMARY KEY,edition_id TEXT NOT NULL REFERENCES editions(id),brand_id TEXT NOT NULL REFERENCES brands(id),session_id TEXT REFERENCES edition_sessions(id),kind TEXT NOT NULL CHECK(kind IN ('material','recording','link')),title TEXT NOT NULL,url TEXT NOT NULL DEFAULT '',file_id TEXT REFERENCES library_files(id),created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    CREATE INDEX edition_resources_edition ON edition_resources(edition_id,created_at);
    PRAGMA user_version=19;
  `),
  );
}
