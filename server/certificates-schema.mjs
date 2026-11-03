import {transaction} from './database.mjs';

// Esquema v22 (Fase 2 · bloque 2.5 Certificación). Un solo emisor dentro del CRM: el certificado nace de una inscripción
// con asistencia cumplida en una apertura, con folio secuencial IPCI-AAAA-NNNNN (una secuencia por año, asignada dentro
// de la transacción), snapshot de lo certificado y verificación pública por folio. Ajustes por marca (emisión automática
// al cerrar, asistencia mínima, nombres de quien firma, logotipo de la biblioteca) y créditos opcionales por consultora.
export function migrateCertificates(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=22)return;
  transaction(db,()=>db.exec(`
    CREATE TABLE certificate_settings(brand_id TEXT PRIMARY KEY REFERENCES brands(id),auto_issue INTEGER NOT NULL DEFAULT 0,min_attendance_pct INTEGER NOT NULL DEFAULT 80 CHECK(min_attendance_pct BETWEEN 0 AND 100),issuer_name TEXT NOT NULL DEFAULT 'IPCI · TEC Capital',signer_name TEXT NOT NULL DEFAULT '',signer_title TEXT NOT NULL DEFAULT '',logo_file_id TEXT REFERENCES library_files(id),accent TEXT NOT NULL DEFAULT '#30343c',credits_enabled INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT REFERENCES users(id),updated_at INTEGER NOT NULL);
    CREATE TABLE certificate_sequences(year INTEGER PRIMARY KEY,last INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE certificates(id TEXT PRIMARY KEY,folio TEXT NOT NULL UNIQUE,brand_id TEXT NOT NULL REFERENCES brands(id),enrollment_id TEXT NOT NULL REFERENCES enrollments(id),person_id TEXT REFERENCES persons(id),contact_id TEXT NOT NULL REFERENCES contacts(id),course_id TEXT NOT NULL REFERENCES courses(id),edition_id TEXT NOT NULL REFERENCES editions(id),holder_name TEXT NOT NULL,course_title TEXT NOT NULL,edition_name TEXT NOT NULL,brand_name TEXT NOT NULL,sessions_held INTEGER NOT NULL,sessions_attended INTEGER NOT NULL,attendance_pct INTEGER NOT NULL,hours INTEGER,issued_at INTEGER NOT NULL,issued_by TEXT REFERENCES users(id),source TEXT NOT NULL CHECK(source IN ('manual','auto')),status TEXT NOT NULL CHECK(status IN ('issued','revoked')),revoked_at INTEGER,revoked_by TEXT REFERENCES users(id),revoke_reason TEXT NOT NULL DEFAULT '',snapshot TEXT NOT NULL DEFAULT '{}',verifications INTEGER NOT NULL DEFAULT 0,last_verified_at INTEGER,created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX certificates_active ON certificates(enrollment_id) WHERE status='issued';
    CREATE INDEX certificates_brand ON certificates(brand_id,issued_at);
    CREATE INDEX certificates_edition ON certificates(edition_id);
    CREATE TABLE certificate_credits(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),delta INTEGER NOT NULL,reason TEXT NOT NULL DEFAULT '',certificate_id TEXT REFERENCES certificates(id),actor_id TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    CREATE INDEX certificate_credits_brand ON certificate_credits(brand_id,created_at);
    PRAGMA user_version=22;
  `));
}
