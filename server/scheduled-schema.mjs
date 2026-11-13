import { transaction } from './database.mjs';

// Esquema v32: mensajes programados (docs/PLAN_MENSAJES_PROGRAMADOS.md). Un mensaje de texto que una persona del equipo deja listo en un
// chat para que salga solo a una hora. La fila no es el mensaje: al enviarse se crea el mensaje normal (con su `client_ref` determinista
// `sched:<id>`, para que un reintento no lo duplique) y aquí queda `message_id`. Aditivo: sólo una tabla nueva.
export function migrateScheduled(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 32) return;
  transaction(db, () =>
    db.exec(`
    CREATE TABLE scheduled_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),brand_id TEXT NOT NULL REFERENCES brands(id),
      author_id TEXT NOT NULL REFERENCES users(id),text TEXT NOT NULL,send_at INTEGER NOT NULL,cancel_on_reply INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','cancelled','failed')),reason TEXT,message_id TEXT REFERENCES messages(id),
      client_ref TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,sent_at INTEGER,
      UNIQUE(author_id,client_ref));
    CREATE INDEX scheduled_due ON scheduled_messages(state,send_at);
    CREATE INDEX scheduled_conversation ON scheduled_messages(conversation_id,state);
    PRAGMA user_version=32;
  `),
  );
}

// Esquema v37: un mensaje programado puede ser un MATERIAL del catálogo (temario, precio y promoción, fechas, flyer o una plantilla aprobada) en lugar de un texto
// fijo. `material` guarda qué es (JSON: kind, templateId o flyerId) y `material_label` cómo se llama; el texto real se ARMA al enviar, con el catálogo vigente de ese
// momento (docs/PLAN_MENSAJES_PROGRAMADOS.md). Aditivo.
export function migrateScheduledMaterial(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 37) return;
  transaction(db, () =>
    db.exec(`
    ALTER TABLE scheduled_messages ADD COLUMN material TEXT;
    ALTER TABLE scheduled_messages ADD COLUMN material_label TEXT;
    PRAGMA user_version=37;
  `),
  );
}
