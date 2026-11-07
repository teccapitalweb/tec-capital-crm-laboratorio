import {transaction} from './database.mjs';

// Esquema v33: agenda de citas (docs/PLAN_AGENDA_CITAS.md). Una cita es un compromiso con fecha, hora y duración entre una persona del equipo y
// quien escribe en un chat (llamada, videollamada o presencial). Cuelga de la conversación (de ahí salen la marca y el cliente) y de quien la lleva.
// `reminder_id` apunta al recordatorio para el cliente, que es un mensaje programado normal (docs/PLAN_MENSAJES_PROGRAMADOS.md): así hereda sus reglas.
// Aditivo: sólo una tabla nueva.
export function migrateAppointments(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=33)return;
  transaction(db,()=>db.exec(`
    CREATE TABLE appointments(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),brand_id TEXT NOT NULL REFERENCES brands(id),
      owner_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,starts_at INTEGER NOT NULL,duration_min INTEGER NOT NULL DEFAULT 30,
      kind TEXT NOT NULL DEFAULT 'llamada' CHECK(kind IN ('llamada','videollamada','presencial')),place TEXT,notes TEXT,
      state TEXT NOT NULL DEFAULT 'scheduled' CHECK(state IN ('scheduled','done','no_show','cancelled')),reminder_id TEXT REFERENCES scheduled_messages(id),
      client_ref TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      UNIQUE(owner_id,client_ref));
    CREATE INDEX appointments_owner ON appointments(owner_id,state,starts_at);
    CREATE INDEX appointments_conversation ON appointments(conversation_id,starts_at);
    PRAGMA user_version=33;
  `));
}
