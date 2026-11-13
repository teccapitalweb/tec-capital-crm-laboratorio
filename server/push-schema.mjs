import { transaction } from './database.mjs';

// Esquema v27: notificaciones push (Web Push) para el equipo. Aditivo. Claves VAPID propias del servidor, suscripciones por
// dispositivo, preferencias por persona y una marca `pushed_at` en los avisos existentes para que el envío sea idempotente
// sin tocar los lugares donde se crean avisos. Los avisos anteriores a esta migración quedan como ya enviados (no se reenvía
// el historial al activar).
export function migratePush(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 27) return;
  transaction(db, () =>
    db.exec(`
    CREATE TABLE push_keys(id INTEGER PRIMARY KEY CHECK(id=1),public_key TEXT NOT NULL,private_jwk TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE push_subscriptions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),endpoint TEXT NOT NULL UNIQUE,p256dh TEXT NOT NULL,auth TEXT NOT NULL,user_agent TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,last_ok_at INTEGER,last_error TEXT,failures INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
    CREATE TABLE push_prefs(user_id TEXT PRIMARY KEY REFERENCES users(id),groups TEXT NOT NULL DEFAULT '["chats","sla","sales","ops"]',updated_at INTEGER NOT NULL);
    ALTER TABLE notifications ADD COLUMN pushed_at INTEGER;
    UPDATE notifications SET pushed_at=created_at;
    CREATE INDEX notifications_unpushed ON notifications(pushed_at,created_at);
    PRAGMA user_version=27;
  `),
  );
}
