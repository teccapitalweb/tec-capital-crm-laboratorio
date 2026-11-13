import { transaction } from './database.mjs';

// Esquema v30: Aliados (docs/PLAN_ALIADOS.md). Trae al CRM lo que hacía el panel RH de IPCIL: la bandeja de postulaciones de academias que
// quieren ser «Aliado Certificador» (compromiso: contactarlas en menos de 24 horas, aprobarlas y mandarles la invitación) y las
// solicitudes de las marcas que piden ayuda para vincular su WhatsApp. Aditivo: sólo tablas nuevas.
//  - rh_access: la función de RH que concede administración.
//  - ally_applications: la postulación y su recorrido (nueva → contactada → aprobada o rechazada; invitación enviada), con quién y cuándo.
//  - channel_requests: «ayúdenme a vincular mi WhatsApp» de una marca, con teléfono y horario; RH la marca contactada.
export function migrateAllies(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 30) return;
  transaction(db, () =>
    db.exec(`
    CREATE TABLE rh_access(user_id TEXT PRIMARY KEY REFERENCES users(id),granted_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    CREATE TABLE ally_applications(id TEXT PRIMARY KEY,academy TEXT NOT NULL,contact_name TEXT NOT NULL,city TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL,whatsapp TEXT NOT NULL,sector TEXT NOT NULL DEFAULT '',years TEXT NOT NULL DEFAULT '',students_month TEXT NOT NULL DEFAULT '',
      issues_certificates TEXT NOT NULL DEFAULT '' CHECK(issues_certificates IN ('','si','no','a_veces')),web TEXT NOT NULL DEFAULT '',heard_from TEXT NOT NULL DEFAULT '',message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','approved','rejected')),source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','public')),
      contacted_by TEXT REFERENCES users(id),contacted_at INTEGER,contact_note TEXT NOT NULL DEFAULT '',decided_by TEXT REFERENCES users(id),decided_at INTEGER,decision_note TEXT NOT NULL DEFAULT '',
      invited_by TEXT REFERENCES users(id),invited_at INTEGER,invite_note TEXT NOT NULL DEFAULT '',client_ref TEXT UNIQUE,created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX ally_applications_status ON ally_applications(status,created_at);
    CREATE TABLE channel_requests(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),requester_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,role TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL,schedule TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','contacted')),
      contacted_by TEXT REFERENCES users(id),contacted_at INTEGER,contact_note TEXT NOT NULL DEFAULT '',client_ref TEXT UNIQUE,created_at INTEGER NOT NULL);
    CREATE INDEX channel_requests_status ON channel_requests(status,created_at);
    PRAGMA user_version=30;
  `),
  );
}
