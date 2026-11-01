import {transaction} from './database.mjs';

// Esquema v15: canal simulado realista. Estados de entrega por mensaje saliente, categoría (servicio / utilidad /
// marketing), botones de respuesta rápida, llegada por anuncio (referral) y ajustes por marca, apagados por omisión.
// Los mensajes ya leídos quedan como «read» para que el historial sea coherente; el resto conserva «sent».
export function migrateChannel(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=15)return;
  transaction(db,()=>{
    db.exec(`
    ALTER TABLE messages ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'sent' CHECK(delivery_state IN ('sent','delivered','read','failed'));
    ALTER TABLE messages ADD COLUMN delivered_at INTEGER;
    ALTER TABLE messages ADD COLUMN failed_reason TEXT;
    ALTER TABLE messages ADD COLUMN category TEXT CHECK(category IS NULL OR category IN ('service','utility','marketing'));
    ALTER TABLE messages ADD COLUMN buttons TEXT;
    ALTER TABLE conversations ADD COLUMN referral TEXT;
    UPDATE messages SET delivery_state='read' WHERE read_at IS NOT NULL AND sender_kind IN ('agent','automation');
    CREATE TABLE channel_settings(brand_id TEXT PRIMARY KEY REFERENCES brands(id),enabled INTEGER NOT NULL DEFAULT 0,enforce_window INTEGER NOT NULL DEFAULT 1,delivery_delay_ms INTEGER NOT NULL DEFAULT 1500,failure_rate INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT REFERENCES users(id),updated_at INTEGER NOT NULL);
    CREATE TABLE channel_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL REFERENCES messages(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),brand_id TEXT NOT NULL REFERENCES brands(id),state TEXT NOT NULL,reason TEXT,actor_id TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    CREATE INDEX channel_events_message ON channel_events(message_id,seq);
    CREATE INDEX messages_delivery ON messages(delivery_state,created_at);
    PRAGMA user_version=15;`);
  });
}
