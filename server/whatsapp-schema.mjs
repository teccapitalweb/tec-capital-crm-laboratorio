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

// Esquema v39: plantillas de WhatsApp aprobadas por Meta (docs/PLAN_PLANTILLAS_WHATSAPP.md). Con la ventana de 24 h cerrada sólo puede salir una plantilla.
//   wa_templates          plantilla por marca: nombre e idioma en Meta, categoría, para qué se usa (manual o aviso), texto con {{1}}… y qué dato llena cada variable.
//   messages.wa_template  el mensaje sale como plantilla (nombre, idioma y valores ya resueltos al guardarlo).
//   messages.wa_hold      el mensaje espera a que la persona vuelva a escribir (se le mandó un aviso); NULL = no espera.
export function migrateWhatsAppTemplates(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=39)return;
  transaction(db,()=>{
    db.exec("CREATE TABLE wa_templates(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),name TEXT NOT NULL,language TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('utility','marketing')),purpose TEXT NOT NULL DEFAULT 'manual' CHECK(purpose IN ('manual','notice')),body TEXT NOT NULL,variables TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'draft',meta_id TEXT,reject_reason TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,synced_at INTEGER,UNIQUE(name,language));"
      +"CREATE INDEX wa_templates_brand ON wa_templates(brand_id,status);ALTER TABLE messages ADD COLUMN wa_template TEXT;ALTER TABLE messages ADD COLUMN wa_hold INTEGER;CREATE INDEX messages_wa_hold ON messages(wa_hold) WHERE wa_hold IS NOT NULL;PRAGMA user_version=39;");
  });
}

// Esquema v41: un número de WhatsApp para toda la consultora (docs/PLAN_NUMERO_POR_CONSULTORA.md).
//   wa_numbers.multi              el número atiende TODOS los cursos de su marca (apagado por omisión: sigue recibiendo en su curso de siempre).
//   conversations.course_pending  la persona todavía no dice qué curso le interesa: el asistente se lo pregunta antes de hablar de precios o fechas.
//   wa_ads                        anuncios de Meta por los que han llegado personas, por marca, y el curso al que pertenece cada uno (lo asigna administración).
export function migrateWhatsAppMulti(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=41)return;
  transaction(db,()=>{
    db.exec("ALTER TABLE wa_numbers ADD COLUMN multi INTEGER NOT NULL DEFAULT 0;ALTER TABLE conversations ADD COLUMN course_pending INTEGER NOT NULL DEFAULT 0;"
      +"CREATE TABLE wa_ads(brand_id TEXT NOT NULL REFERENCES brands(id),ad_id TEXT NOT NULL,headline TEXT NOT NULL DEFAULT '',body TEXT NOT NULL DEFAULT '',course_id TEXT REFERENCES courses(id),hits INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT REFERENCES users(id),first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,PRIMARY KEY(brand_id,ad_id));PRAGMA user_version=41;");
  });
}
