import {transaction} from './database.mjs';

// Esquema v38: WhatsApp real (Meta · Cloud API). Tres piezas, todas vacías hasta que alguien escriba a un número real:
//   wa_numbers     número de WhatsApp (su «phone number ID» de Meta) → marca y curso por omisión. Sin secretos: el token vive en el entorno.
//   wa_identities  persona real (su «wa_id») → cliente del CRM. Una persona es el mismo cliente aunque escriba a varias marcas.
//   conversations  wa_number / wa_peer: la conversación es REAL cuando los tiene; las del laboratorio los dejan en NULL y siguen simuladas.
export function migrateWhatsApp(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=38)return;
  transaction(db,()=>{
    db.exec(`
    CREATE TABLE wa_numbers(phone_number_id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),course_id TEXT REFERENCES courses(id),label TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX wa_numbers_brand ON wa_numbers(brand_id);
    CREATE TABLE wa_identities(wa_id TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id),profile_name TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,last_seen INTEGER NOT NULL);
    ALTER TABLE conversations ADD COLUMN wa_number TEXT;
    ALTER TABLE conversations ADD COLUMN wa_peer TEXT;
    CREATE INDEX conversations_wa ON conversations(wa_number,wa_peer) WHERE wa_number IS NOT NULL;
    PRAGMA user_version=38;`);
  });
}
