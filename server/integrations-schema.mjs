import {transaction} from './database.mjs';

// Esquema v35: API pública y webhooks salientes (docs/PLAN_API_PUBLICA.md). Tres tablas nuevas, todas por marca:
//  · api_keys: llaves de la API de lectura. Sólo se guarda el hash (SHA-256) y un prefijo para reconocerlas; el valor completo se muestra una sola vez.
//  · webhook_endpoints: direcciones HTTPS a las que el CRM avisa de los eventos de dominio. El secreto de firma se guarda (hace falta para firmar cada envío).
//  · webhook_deliveries: una fila por evento y destino, con intentos, siguiente intento y el último código recibido. UNIQUE(endpoint, evento) evita duplicados.
// Aditivo: sin cambios en tablas existentes.
export function migrateIntegrations(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=35)return;
  transaction(db,()=>db.exec(`
    CREATE TABLE api_keys(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),name TEXT NOT NULL,prefix TEXT NOT NULL,key_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),created_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,last_used_at INTEGER,revoked_at INTEGER);
    CREATE INDEX api_keys_brand ON api_keys(brand_id,status);
    CREATE TABLE webhook_endpoints(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),url TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
      events TEXT NOT NULL DEFAULT '["*"]',secret TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','disabled')),
      failure_count INTEGER NOT NULL DEFAULT 0,disabled_reason TEXT,revision INTEGER NOT NULL DEFAULT 1,created_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX webhook_endpoints_brand ON webhook_endpoints(brand_id,status);
    CREATE TABLE webhook_deliveries(id TEXT PRIMARY KEY,endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      event_seq INTEGER NOT NULL REFERENCES domain_events(seq),state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,last_status INTEGER,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      UNIQUE(endpoint_id,event_seq));
    CREATE INDEX webhook_deliveries_due ON webhook_deliveries(state,next_attempt_at);
    CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id,created_at);
    PRAGMA user_version=35;
  `));
}
