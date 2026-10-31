import {transaction} from './database.mjs';
export function migrateAutomation(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=7)return;
  transaction(db,()=>db.exec(`
    ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE jobs ADD COLUMN next_attempt_at INTEGER;
    ALTER TABLE jobs ADD COLUMN last_error TEXT;
    CREATE TABLE automation_settings(brand_id TEXT PRIMARY KEY REFERENCES brands(id),enabled INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT REFERENCES users(id),updated_at INTEGER NOT NULL);
    CREATE TABLE automation_global(id INTEGER PRIMARY KEY CHECK(id=1),paused INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT REFERENCES users(id),updated_at INTEGER NOT NULL);
    INSERT INTO automation_global(id,paused,revision,updated_at) VALUES(1,0,1,0);
    CREATE TABLE automation_steps(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),conversation_id TEXT REFERENCES conversations(id),kind TEXT NOT NULL,payload TEXT NOT NULL DEFAULT '{}',dedupe_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','reserved','completed','cancelled','failed')),scheduled_at INTEGER NOT NULL,next_attempt_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 4,
      lease_owner TEXT,lease_until INTEGER,result TEXT,error TEXT,cancel_reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX automation_due ON automation_steps(state,next_attempt_at);
    CREATE INDEX automation_conversation ON automation_steps(conversation_id,state);
    CREATE TABLE automation_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,step_id TEXT REFERENCES automation_steps(id),brand_id TEXT NOT NULL REFERENCES brands(id),actor_id TEXT REFERENCES users(id),kind TEXT NOT NULL,details TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL);
    CREATE INDEX automation_step_history ON automation_events(step_id,seq);
    PRAGMA user_version=7;
  `));
}

export function migrateRecipes(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=8)return;
  transaction(db,()=>db.exec(`
    CREATE TABLE automation_recipes(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),title TEXT NOT NULL,definition TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','paused')),revision INTEGER NOT NULL DEFAULT 1,activated_at INTEGER,created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX automation_recipes_brand ON automation_recipes(brand_id,status);
    CREATE TABLE automation_recipe_versions(recipe_id TEXT NOT NULL REFERENCES automation_recipes(id),revision INTEGER NOT NULL,snapshot TEXT NOT NULL,actor_id TEXT REFERENCES users(id),created_at INTEGER NOT NULL,PRIMARY KEY(recipe_id,revision));
    CREATE TABLE automation_runs(id TEXT PRIMARY KEY,recipe_id TEXT NOT NULL REFERENCES automation_recipes(id),recipe_revision INTEGER NOT NULL,brand_id TEXT NOT NULL REFERENCES brands(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),source_key TEXT NOT NULL,step_id TEXT NOT NULL REFERENCES automation_steps(id),created_at INTEGER NOT NULL,UNIQUE(recipe_id,source_key));
    CREATE INDEX automation_runs_recipe ON automation_runs(recipe_id,created_at);
    PRAGMA user_version=8;
  `));
}
