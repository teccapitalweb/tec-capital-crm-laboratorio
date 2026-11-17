// Secuencias de seguimiento (docs/PLAN_SECUENCIAS.md; diseño de automatización §5.8; conciliación, fila N-6).
// Aditiva: tablas nuevas, sin tocar las de otras áreas.
//
//   sequences             una secuencia por fila: título, curso opcional, pasos (JSON), ajustes (JSON), encendida o
//                         no (nace apagada) y archivada. `revision` es la de expectedRevision. `trigger_cursor` es el
//                         último `messages.seq` que miró la entrada automática (sólo cuenta lo nuevo desde que se
//                         encendió, nunca el historial).
//   sequence_enrollments  una inscripción por persona y secuencia: copia de los pasos y ajustes al inscribir (editar la
//                         secuencia no cambia las inscripciones en curso), edición del catálogo elegida al inscribir,
//                         estado (active, paused, completed, stopped) y su motivo. `schedule_seq` sube cada vez que se
//                         programa un paso: es parte de la clave del paso durable (`seq:<id>:<índice>:<schedule_seq>`).
//                         `reply_seen_seq` es el último mensaje de la persona ya leído (modelo de consulta, sin gancho
//                         en el entrante). Una sola inscripción viva por (secuencia, conversación): índice parcial.
//   sequence_events       bitácora por inscripción y paso: inscrita, enviado, omitido, en espera, respondió, dijo sí,
//                         dijo no, en pausa, reanudada, detenida, terminada. Es la fuente de los resultados.
//
// Sin columna de contacto: la persona se lee de la conversación (conversation_opportunities), así una fusión de
// contactos no deja filas huérfanas y no hay tabla nueva que declarar en el registro de datos de persona.
export default {
  name: 'sequences/0001-sequences',
  after: [],
  up(db) {
    db.exec(`
      CREATE TABLE sequences(
        id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id), title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', course_id TEXT REFERENCES courses(id),
        steps TEXT NOT NULL DEFAULT '[]', settings TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 0, enabled_at INTEGER, archived_at INTEGER,
        trigger_cursor INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1, client_ref TEXT,
        created_by TEXT REFERENCES users(id), updated_by TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX sequences_brand ON sequences(brand_id,archived_at,updated_at);
      CREATE UNIQUE INDEX sequences_client_ref ON sequences(brand_id,client_ref) WHERE client_ref IS NOT NULL;
      CREATE TABLE sequence_enrollments(
        id TEXT PRIMARY KEY, sequence_id TEXT NOT NULL REFERENCES sequences(id),
        brand_id TEXT NOT NULL REFERENCES brands(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
        sequence_revision INTEGER NOT NULL, definition TEXT NOT NULL,
        course_id TEXT REFERENCES courses(id), edition_id TEXT REFERENCES editions(id),
        state TEXT NOT NULL CHECK(state IN ('active','paused','completed','stopped')), reason TEXT,
        next_index INTEGER NOT NULL DEFAULT 0, schedule_seq INTEGER NOT NULL DEFAULT 0, next_due_at INTEGER,
        last_sent_at INTEGER, last_step_index INTEGER, reply_seen_seq INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL, started_by TEXT REFERENCES users(id), client_ref TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        started_at INTEGER NOT NULL, paused_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX sequence_active ON sequence_enrollments(sequence_id,conversation_id)
        WHERE state IN ('active','paused');
      CREATE UNIQUE INDEX sequence_enrollments_ref ON sequence_enrollments(brand_id,client_ref)
        WHERE client_ref IS NOT NULL;
      CREATE INDEX sequence_enrollments_conversation ON sequence_enrollments(conversation_id,state);
      CREATE INDEX sequence_enrollments_state ON sequence_enrollments(state,brand_id,next_due_at);
      CREATE INDEX sequence_enrollments_sequence ON sequence_enrollments(sequence_id,state,started_at);
      CREATE TABLE sequence_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, brand_id TEXT NOT NULL REFERENCES brands(id),
        sequence_id TEXT NOT NULL REFERENCES sequences(id),
        enrollment_id TEXT NOT NULL REFERENCES sequence_enrollments(id),
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        step_index INTEGER, event TEXT NOT NULL, detail TEXT, message_id TEXT, at INTEGER NOT NULL);
      CREATE INDEX sequence_events_sequence ON sequence_events(sequence_id,event,step_index);
      CREATE INDEX sequence_events_enrollment ON sequence_events(enrollment_id,seq);
    `);
  },
};
