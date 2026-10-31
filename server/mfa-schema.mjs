import {transaction} from './database.mjs';
export function migrateMfa(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=12)return;
  transaction(db,()=>db.exec(`
    CREATE TABLE user_mfa(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,secret TEXT NOT NULL,pending INTEGER NOT NULL DEFAULT 1,recovery TEXT NOT NULL DEFAULT '[]',last_step INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,enabled_at INTEGER);
    PRAGMA user_version=12;
  `));
}
