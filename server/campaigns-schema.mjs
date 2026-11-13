import { transaction } from './database.mjs';

// Esquema v26: campañas y envíos segmentados. Aditivo: no toca ninguna tabla existente. Las campañas usan los pasos
// durables de automation_steps (un paso por destinatario); aquí sólo vive la definición, la membresía y la bitácora.
// El estado de cada envío (programado, enviado, omitido, fallido) se lee del paso y del mensaje: una sola fuente de verdad.
export function migrateCampaigns(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 26) return;
  transaction(db, () =>
    db.exec(`
    CREATE TABLE campaign_settings(brand_id TEXT PRIMARY KEY REFERENCES brands(id),enabled INTEGER NOT NULL DEFAULT 0,min_gap_hours INTEGER NOT NULL DEFAULT 72,pace_seconds INTEGER NOT NULL DEFAULT 2,max_audience INTEGER NOT NULL DEFAULT 5000,revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT REFERENCES users(id),updated_at INTEGER NOT NULL);
    CREATE TABLE campaigns(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),title TEXT NOT NULL,template_id TEXT NOT NULL REFERENCES content_templates(id),segment TEXT NOT NULL DEFAULT '{}',require_consent INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','sending','completed','cancelled')),scheduled_at INTEGER,audience_confirmed INTEGER,audience_size INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,client_ref TEXT UNIQUE,
      created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,started_at INTEGER,launched_at INTEGER,finished_at INTEGER);
    CREATE INDEX campaigns_brand ON campaigns(brand_id,updated_at);
    CREATE INDEX campaigns_due ON campaigns(status,scheduled_at);
    CREATE TABLE campaign_recipients(campaign_id TEXT NOT NULL REFERENCES campaigns(id),contact_id TEXT NOT NULL REFERENCES contacts(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),step_id TEXT NOT NULL REFERENCES automation_steps(id),created_at INTEGER NOT NULL,PRIMARY KEY(campaign_id,contact_id));
    CREATE INDEX campaign_recipients_step ON campaign_recipients(step_id);
    CREATE TABLE campaign_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,campaign_id TEXT NOT NULL REFERENCES campaigns(id),kind TEXT NOT NULL,details TEXT NOT NULL DEFAULT '{}',actor_id TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    CREATE INDEX campaign_history ON campaign_events(campaign_id,seq);
    PRAGMA user_version=26;
  `),
  );
}
