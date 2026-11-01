import {transaction} from './database.mjs';

// Esquema v14: simulador de clientes. Las demos y sus clientes ficticios se registran aparte para poder listarlos,
// medirlos y archivarlos sin tocar conversaciones reales. Los clientes simulados son usuarios `customer` normales
// (sus mensajes entran por la misma API pública), identificados aquí por `simulator_actors.user_id`.
export function migrateSimulator(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=14)return;
  transaction(db,()=>{
    db.exec(`
    CREATE TABLE simulator_runs(id TEXT PRIMARY KEY,title TEXT NOT NULL,brand_ids TEXT NOT NULL,personas TEXT NOT NULL,pace TEXT NOT NULL,count INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('running','finished','stopped','archived')),created_by TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,stopped_at INTEGER,archived_at INTEGER);
    CREATE TABLE simulator_actors(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES simulator_runs(id),user_id TEXT NOT NULL REFERENCES users(id),persona TEXT NOT NULL,brand_id TEXT NOT NULL REFERENCES brands(id),course_id TEXT NOT NULL REFERENCES courses(id),edition_id TEXT NOT NULL,channel TEXT NOT NULL,conversation_id TEXT REFERENCES conversations(id),step INTEGER NOT NULL DEFAULT 0,phase TEXT NOT NULL DEFAULT 'send' CHECK(phase IN ('send','wait')),state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','waiting','done','stopped','failed')),outcome TEXT,next_at INTEGER NOT NULL,waiting_since INTEGER,last_seq INTEGER NOT NULL DEFAULT 0,sent INTEGER NOT NULL DEFAULT 0,got_bot INTEGER NOT NULL DEFAULT 0,got_human INTEGER NOT NULL DEFAULT 0,errors INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX simulator_actors_due ON simulator_actors(run_id,state,next_at);
    CREATE INDEX simulator_actors_user ON simulator_actors(user_id);
    PRAGMA user_version=14;`);
  });
}
