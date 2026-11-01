import {transaction} from './database.mjs';

// Esquema v16: venta con pago simulado. Pedidos con referencia y enlace de pago de prueba, comprobantes en cola de
// validación, inscripciones y bitácora de eventos de pago. Apagado por marca por omisión (`payment_settings.enabled`).
export function migratePayments(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=16)return;
  transaction(db,()=>{
    db.exec(`
    CREATE TABLE payment_settings(brand_id TEXT PRIMARY KEY REFERENCES brands(id),enabled INTEGER NOT NULL DEFAULT 0,link_hours INTEGER NOT NULL DEFAULT 48,revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT REFERENCES users(id),updated_at INTEGER NOT NULL);
    CREATE TABLE orders(id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,brand_id TEXT NOT NULL REFERENCES brands(id),contact_id TEXT NOT NULL REFERENCES contacts(id),opportunity_id TEXT NOT NULL REFERENCES opportunities(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),course_id TEXT NOT NULL REFERENCES courses(id),edition_id TEXT NOT NULL REFERENCES editions(id),promotion_id TEXT REFERENCES promotions(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),currency TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','review','paid','cancelled','expired')),method TEXT CHECK(method IS NULL OR method IN ('card','oxxo','transfer')),provider_ref TEXT,source TEXT NOT NULL CHECK(source IN ('agent','bot')),created_by TEXT REFERENCES users(id),expires_at INTEGER NOT NULL,paid_at INTEGER,confirmed_by TEXT REFERENCES users(id),note TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX orders_brand ON orders(brand_id,status,created_at);
    CREATE INDEX orders_conversation ON orders(conversation_id,status);
    CREATE TABLE receipts(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),attachment_id TEXT NOT NULL REFERENCES attachments(id),status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),prelecture TEXT NOT NULL,reviewed_by TEXT REFERENCES users(id),review_note TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,reviewed_at INTEGER);
    CREATE INDEX receipts_order ON receipts(order_id,status);
    CREATE TABLE enrollments(id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),brand_id TEXT NOT NULL REFERENCES brands(id),contact_id TEXT NOT NULL REFERENCES contacts(id),opportunity_id TEXT NOT NULL REFERENCES opportunities(id),course_id TEXT NOT NULL REFERENCES courses(id),edition_id TEXT NOT NULL REFERENCES editions(id),status TEXT NOT NULL CHECK(status IN ('enrolled','cancelled')),created_at INTEGER NOT NULL);
    CREATE TABLE payment_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT NOT NULL REFERENCES orders(id),kind TEXT NOT NULL,details TEXT NOT NULL DEFAULT '{}',actor_id TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    CREATE INDEX payment_events_order ON payment_events(order_id,seq);
    PRAGMA user_version=16;`);
  });
}
