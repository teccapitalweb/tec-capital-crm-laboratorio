// Identidad por identificador de usuario (docs/PLAN_IDENTIDAD_SIN_TELEFONO.md, incremento I-2).
//
//   identity_keys    llaves con las que se reconoce a un cliente: su teléfono (wa_phone, clave canónica, ámbito '') y
//                    su identificador de usuario de WhatsApp (wa_bsuid y wa_parent_bsuid, con el ámbito de la cuenta
//                    de Meta del número). `kind` no lleva CHECK: los demás canales añadirán sus tipos sin reconstruir.
//   identity_events  bitácora de vínculos: quién ganó, perdió o compartió una llave y por qué. Nunca guarda el valor
//                    completo, sólo sus últimos cuatro caracteres (`hint`).
//   wa_peer_state    último mensaje de cada persona a cada número de la empresa: la ventana de 24 horas es por persona
//                    y número, no por conversación (channel.windowOf la lee).
//   wa_numbers       waba_id (cuenta de WhatsApp Business del número, se aprende del webhook) y business_id
//                    (portafolio de Meta, el ámbito del identificador; hoy nadie lo llena).
//
// Sólo crea: copiar los teléfonos de wa_identities y llenar wa_peer_state lo hace por trozos el trabajo
// `identity.backfill` (server/modules/identity), así una base grande no detiene el arranque. Mientras tanto el entrante
// sigue reconociendo a quien tiene teléfono por wa_identities.
import { addColumn } from '../../named.mjs';

export default {
  name: 'identity/0002-user-keys',
  after: [],
  up(db) {
    db.exec(`
      CREATE TABLE identity_keys(
        kind TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        value TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        wa_id TEXT,
        username TEXT NOT NULL DEFAULT '',
        profile_name TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        phone_seen_at INTEGER,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY(kind,scope,value)
      );
      CREATE INDEX identity_keys_user ON identity_keys(user_id,kind);
      CREATE TABLE identity_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        other_user_id TEXT,
        kind TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('added','linked','moved','released','merged','conflict')),
        hint TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX identity_events_user ON identity_events(user_id,seq);
      CREATE INDEX identity_events_action ON identity_events(action,created_at);
      CREATE TABLE wa_peer_state(
        phone_number_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        last_inbound_at INTEGER NOT NULL,
        PRIMARY KEY(phone_number_id,user_id)
      );
    `);
    addColumn(db, 'wa_numbers', 'waba_id', 'TEXT');
    addColumn(db, 'wa_numbers', 'business_id', 'TEXT');
  },
};
