import { transaction } from './database.mjs';

// Esquema v31: resumen de conversación (docs/PLAN_RESUMEN_CONVERSACION.md). Una fila por conversación con el último resumen: el texto,
// sus datos estructurados, desde dónde se calculó (`upto_seq`, para saber cuántos mensajes nuevos hay), cómo se hizo (reglas o IA) y con qué
// modelo. Se reescribe al actualizar; el historial de mensajes sigue siendo la fuente. Aditivo: sólo una tabla nueva.
export function migrateSummaries(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 31) return;
  transaction(db, () =>
    db.exec(`
    CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),upto_seq INTEGER NOT NULL,message_count INTEGER NOT NULL,
      text TEXT NOT NULL,data TEXT NOT NULL DEFAULT '{}',source TEXT NOT NULL CHECK(source IN ('rules','ai')),model TEXT,requested_by TEXT REFERENCES users(id),
      revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    PRAGMA user_version=31;
  `),
  );
}
