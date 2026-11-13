import { transaction } from './database.mjs';
export function migrateContacts(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 9) return;
  transaction(db, () =>
    db.exec(`
    CREATE TABLE contact_tags(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),name TEXT NOT NULL,name_key TEXT NOT NULL,color TEXT NOT NULL DEFAULT 'neutral',created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,UNIQUE(brand_id,name_key));
    CREATE TABLE contact_tag_links(contact_id TEXT NOT NULL REFERENCES contacts(id),tag_id TEXT NOT NULL REFERENCES contact_tags(id),created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,PRIMARY KEY(contact_id,tag_id));
    CREATE INDEX contact_tag_links_tag ON contact_tag_links(tag_id);
    CREATE TABLE contact_merges(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),kept_id TEXT NOT NULL,merged_id TEXT NOT NULL,merged_snapshot TEXT NOT NULL,moved TEXT NOT NULL,actor_id TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    CREATE INDEX contact_merges_kept ON contact_merges(kept_id,created_at);
    PRAGMA user_version=9;
  `),
  );
}

export function migrateConsent(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 10) return;
  transaction(db, () =>
    db.exec(`
    CREATE TABLE contact_consent(contact_id TEXT PRIMARY KEY REFERENCES contacts(id),brand_id TEXT NOT NULL REFERENCES brands(id),status TEXT NOT NULL CHECK(status IN ('unknown','opted_in','opted_out')),source TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',actor_id TEXT REFERENCES users(id),updated_at INTEGER NOT NULL);
    CREATE TABLE contact_consent_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,contact_id TEXT NOT NULL,brand_id TEXT NOT NULL REFERENCES brands(id),status TEXT NOT NULL,source TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',actor_id TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    CREATE INDEX contact_consent_history ON contact_consent_events(contact_id,seq);
    PRAGMA user_version=10;
  `),
  );
}
