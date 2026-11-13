import { transaction } from './database.mjs';

// Esquema v17: contrato de conectores. Referencia del proveedor por mensaje, URL de pago del proveedor por pedido y
// bitácora idempotente de eventos recibidos por webhook (un evento por proveedor e id).
export function migrateConnectors(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 17) return;
  transaction(db, () => {
    db.exec(`
    ALTER TABLE messages ADD COLUMN provider_ref TEXT;
    CREATE INDEX messages_provider_ref ON messages(provider_ref);
    ALTER TABLE orders ADD COLUMN checkout_url TEXT;
    CREATE TABLE connector_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL CHECK(kind IN ('channel','payment')),provider TEXT NOT NULL,event_id TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(provider,event_id));
    PRAGMA user_version=17;`);
  });
}
