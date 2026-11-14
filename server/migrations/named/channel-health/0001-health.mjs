// Salud del canal (X3, docs/PLAN_SALUD_NUMERO.md; conciliación, fila 39): lo del NÚMERO vive en channel_health y su
// historial en channel_health_events; lo de la CUENTA de WhatsApp Business (límite diario, revisión, pago) sigue en
// wa_account (broadcasts/0001), a la que aquí sólo se le añade lo que faltaba. No se crea wa_number_health.
//
//   channel_health          una fila por número ('wa:' + phone_number_id): nombre visible y su estado, estado del número,
//                           calidad, si es cuenta oficial, última consulta y último aviso, error de la última consulta y
//                           refresh_due (un aviso pidió releer a Meta; el reloj lo hace fuera de toda transacción).
//   channel_health_events   historial de cambios de un número o de la cuenta (account_ref 'waba:<cuenta>', brand_id '*').
//   wa_account              + business_verification, restriction, restricted_until, health_checked_at, health_error,
//                           health_due y last_webhook_at.
import { addColumn } from '../../named.mjs';

export default {
  name: 'channel-health/0001-health',
  after: ['broadcasts/0001-foundations'],
  up(db) {
    db.exec(`
      CREATE TABLE channel_health(
        account_ref TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL REFERENCES brands(id),
        phone_number_id TEXT NOT NULL,
        display TEXT NOT NULL DEFAULT '',
        verified_name TEXT NOT NULL DEFAULT '',
        name_status TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unknown',
        quality TEXT NOT NULL DEFAULT 'unknown',
        official INTEGER,
        last_webhook_at INTEGER,
        checked_at INTEGER,
        error TEXT NOT NULL DEFAULT '',
        refresh_due INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX channel_health_brand ON channel_health(brand_id);
      CREATE TABLE channel_health_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        account_ref TEXT NOT NULL,
        brand_id TEXT NOT NULL,
        field TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        source TEXT NOT NULL CHECK(source IN ('poll','webhook')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX channel_health_events_brand ON channel_health_events(brand_id,seq);
    `);
    addColumn(db, 'wa_account', 'business_verification', 'TEXT');
    addColumn(db, 'wa_account', 'restriction', 'TEXT');
    addColumn(db, 'wa_account', 'restricted_until', 'INTEGER');
    addColumn(db, 'wa_account', 'health_checked_at', 'INTEGER');
    addColumn(db, 'wa_account', 'health_error', "TEXT NOT NULL DEFAULT ''");
    addColumn(db, 'wa_account', 'health_due', 'INTEGER');
    addColumn(db, 'wa_account', 'last_webhook_at', 'INTEGER');
  },
};
