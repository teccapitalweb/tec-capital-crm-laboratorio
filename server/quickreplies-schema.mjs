import {transaction} from './database.mjs';

// Esquema v28: respuestas rápidas del chat (atajos con «/»). Personales (de una persona) o compartidas de una marca. Aditivo.
// Se archivan en vez de borrarse y el atajo queda libre para reutilizarse.
export function migrateQuickReplies(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=28)return;
  transaction(db,()=>db.exec(`
    CREATE TABLE quick_replies(id TEXT PRIMARY KEY,scope TEXT NOT NULL CHECK(scope IN ('personal','brand')),user_id TEXT REFERENCES users(id),brand_id TEXT REFERENCES brands(id),
      shortcut TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,uses INTEGER NOT NULL DEFAULT 0,last_used_at INTEGER,client_ref TEXT UNIQUE,
      archived_at INTEGER,created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      CHECK((scope='personal' AND user_id IS NOT NULL AND brand_id IS NULL) OR (scope='brand' AND brand_id IS NOT NULL AND user_id IS NULL)));
    CREATE UNIQUE INDEX quick_replies_personal ON quick_replies(user_id,shortcut) WHERE scope='personal' AND archived_at IS NULL;
    CREATE UNIQUE INDEX quick_replies_brand ON quick_replies(brand_id,shortcut) WHERE scope='brand' AND archived_at IS NULL;
    PRAGMA user_version=28;
  `));
}
