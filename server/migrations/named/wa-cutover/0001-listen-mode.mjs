// Modo escucha, abrir conversaciones recientes y registrar el número (I-11, docs/PLAN_CAMBIO_DE_NUMERO.md;
// conciliación, fila de datos de `wa_numbers`).
//
//   wa_numbers        + mode ('live' por omisión: los números que ya existen siguen activos, igual que hoy, o
//                       'listen'), listen_allow (lista de prueba: claves de teléfono en JSON), mode_changed_at y
//                       registered_at (último registro del número en la cuenta de Meta; el PIN nunca se guarda).
//   wa_listen_days    contadores por número y día en escucha: recibidos, personas distintas, estados de mensajes del
//                     proveedor anterior y errores. Lo «sin identidad» se lee de la cuarentena de la bandeja.
//   wa_listen_seen    lo ya contado (referencia de Meta del mensaje, o día y cliente interno), para no contar dos
//                     veces; se limpia a los 35 días. Sin texto ni teléfonos.
//   wa_number_log     historial de las acciones del cambio: a escucha, a activo, conversaciones abiertas, registro.
import { addColumn } from '../../named.mjs';

export default {
  name: 'wa-cutover/0001-listen-mode',
  after: [], // sólo toca wa_numbers (escalera) y sus tablas propias
  up(db) {
    addColumn(db, 'wa_numbers', 'mode', "TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live','listen'))");
    addColumn(db, 'wa_numbers', 'listen_allow', "TEXT NOT NULL DEFAULT '[]'");
    addColumn(db, 'wa_numbers', 'mode_changed_at', 'INTEGER');
    addColumn(db, 'wa_numbers', 'registered_at', 'INTEGER');
    db.exec(`
      CREATE TABLE wa_listen_days(
        phone_number_id TEXT NOT NULL,
        day TEXT NOT NULL,
        brand_id TEXT NOT NULL,
        received INTEGER NOT NULL DEFAULT 0,
        people INTEGER NOT NULL DEFAULT 0,
        statuses INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(phone_number_id, day)
      );
      CREATE TABLE wa_listen_seen(
        phone_number_id TEXT NOT NULL,
        day TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('message','person')),
        ref TEXT NOT NULL,
        PRIMARY KEY(phone_number_id, kind, ref)
      );
      CREATE INDEX wa_listen_seen_day ON wa_listen_seen(day);
      CREATE TABLE wa_number_log(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number_id TEXT NOT NULL,
        brand_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('listen','live','open_recent','register')),
        detail TEXT NOT NULL DEFAULT '',
        actor_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX wa_number_log_number ON wa_number_log(phone_number_id, seq);
    `);
  },
};
