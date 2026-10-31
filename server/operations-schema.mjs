import {transaction} from './database.mjs';
export function migrateOperations(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=6)return;
  transaction(db,()=>db.exec(`
    CREATE TABLE operation_settings(brand_id TEXT PRIMARY KEY REFERENCES brands(id),routing_enabled INTEGER NOT NULL DEFAULT 0,sla_enabled INTEGER NOT NULL DEFAULT 0,timezone TEXT NOT NULL,hours TEXT NOT NULL,member_ids TEXT NOT NULL DEFAULT '[]',first_minutes INTEGER NOT NULL DEFAULT 30,next_minutes INTEGER NOT NULL DEFAULT 60,revision INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL);
    CREATE TABLE routing_limits(user_id TEXT PRIMARY KEY REFERENCES users(id),max_open INTEGER NOT NULL DEFAULT 8,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE service_state(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),revision INTEGER NOT NULL DEFAULT 1,priority TEXT NOT NULL DEFAULT 'normal',waiting_since INTEGER,first_human_at INTEGER,due_at INTEGER,policy_revision INTEGER,policy TEXT,queued_since INTEGER,last_owner TEXT);
    CREATE TABLE operation_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,brand_id TEXT NOT NULL REFERENCES brands(id),conversation_id TEXT REFERENCES conversations(id),actor_id TEXT REFERENCES users(id),kind TEXT NOT NULL,details TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX operation_history ON operation_events(conversation_id,seq);
    CREATE TABLE transfers(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),brand_id TEXT NOT NULL REFERENCES brands(id),from_id TEXT REFERENCES users(id),to_id TEXT NOT NULL REFERENCES users(id),requested_by TEXT NOT NULL REFERENCES users(id),context TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,decided_at INTEGER);
    CREATE UNIQUE INDEX pending_transfer ON transfers(conversation_id) WHERE status='pending';
    CREATE TABLE notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),brand_id TEXT NOT NULL REFERENCES brands(id),conversation_id TEXT REFERENCES conversations(id),kind TEXT NOT NULL,title TEXT NOT NULL,event_key TEXT NOT NULL,read_at INTEGER,created_at INTEGER NOT NULL,UNIQUE(user_id,event_key));
    CREATE INDEX notifications_inbox ON notifications(user_id,created_at);
    CREATE TABLE macros(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),title TEXT NOT NULL,actions TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE macro_versions(macro_id TEXT NOT NULL REFERENCES macros(id),revision INTEGER NOT NULL,snapshot TEXT NOT NULL,actor_id TEXT REFERENCES users(id),created_at INTEGER NOT NULL,PRIMARY KEY(macro_id,revision));
    CREATE TABLE operation_requests(actor_id TEXT NOT NULL REFERENCES users(id),client_ref TEXT NOT NULL,kind TEXT NOT NULL,target_id TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(actor_id,client_ref));
    PRAGMA user_version=6;
  `));
}

export function migrateHolidays(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=11)return;
  transaction(db,()=>db.exec(`
    ALTER TABLE operation_settings ADD COLUMN holidays TEXT NOT NULL DEFAULT '[]';
    PRAGMA user_version=11;
  `));
}
