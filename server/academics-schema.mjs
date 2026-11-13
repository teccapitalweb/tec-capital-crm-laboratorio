import { transaction } from './database.mjs';

// Esquema v24 (Fase 2 · resto del bloque 2.3: pagos por sesión y encuestas).
// - Pagos por sesión: la edición puede fijar un precio por sesión; una inscripción nace con plan «completo» o «por sesión».
//   Con plan por sesión, el pedido de inscripción cubre la primera sesión disponible y cada sesión siguiente genera su
//   propio pedido (kind='session') con el mismo flujo de pago simulado; session_payments lleva el estado por sesión e
//   inscripción (pendiente, pagada, condonada) con el importe tomado del catálogo al crearse.
// - Encuestas: una por sesión realizada o por apertura; cada inscrito recibe una invitación con token propio por su chat
//   y responde sin sesión en /encuesta/<token> (o desde la app). Las respuestas son anónimas hacia la bitácora común y
//   nominales sólo para el equipo con acceso a la marca.
export function migrateAcademics(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 24) return;
  transaction(db, () =>
    db.exec(`
    ALTER TABLE editions ADD COLUMN session_price_cents INTEGER CHECK(session_price_cents IS NULL OR session_price_cents>=0);
    ALTER TABLE orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'course' CHECK(kind IN ('course','session'));
    ALTER TABLE orders ADD COLUMN plan TEXT NOT NULL DEFAULT 'full' CHECK(plan IN ('full','per_session'));
    ALTER TABLE orders ADD COLUMN session_id TEXT REFERENCES edition_sessions(id);
    ALTER TABLE orders ADD COLUMN enrollment_id TEXT REFERENCES enrollments(id);
    CREATE INDEX orders_session ON orders(session_id,enrollment_id,status);
    ALTER TABLE enrollments ADD COLUMN payment_plan TEXT NOT NULL DEFAULT 'full' CHECK(payment_plan IN ('full','per_session'));
    ALTER TABLE enrollments ADD COLUMN covered_session_id TEXT REFERENCES edition_sessions(id);
    CREATE TABLE session_payments(session_id TEXT NOT NULL REFERENCES edition_sessions(id),enrollment_id TEXT NOT NULL REFERENCES enrollments(id),brand_id TEXT NOT NULL REFERENCES brands(id),status TEXT NOT NULL CHECK(status IN ('pending','paid','waived')),amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),currency TEXT NOT NULL,order_id TEXT REFERENCES orders(id),paid_at INTEGER,waived_by TEXT REFERENCES users(id),note TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(session_id,enrollment_id));
    CREATE INDEX session_payments_enrollment ON session_payments(enrollment_id,status);
    CREATE INDEX session_payments_brand ON session_payments(brand_id,status);
    ALTER TABLE coordination_settings ADD COLUMN charge_sessions INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE coordination_settings ADD COLUMN survey_mode TEXT NOT NULL DEFAULT 'off' CHECK(survey_mode IN ('off','session','close','both'));
    CREATE TABLE surveys(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),edition_id TEXT NOT NULL REFERENCES editions(id),session_id TEXT REFERENCES edition_sessions(id),kind TEXT NOT NULL CHECK(kind IN ('session','edition')),title TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','closed')),source TEXT NOT NULL,created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,closed_by TEXT REFERENCES users(id),closed_at INTEGER);
    CREATE UNIQUE INDEX surveys_target ON surveys(edition_id,COALESCE(session_id,''));
    CREATE TABLE survey_invites(token TEXT PRIMARY KEY,survey_id TEXT NOT NULL REFERENCES surveys(id),brand_id TEXT NOT NULL REFERENCES brands(id),enrollment_id TEXT NOT NULL REFERENCES enrollments(id),contact_id TEXT NOT NULL REFERENCES contacts(id),conversation_id TEXT REFERENCES conversations(id),sent_at INTEGER NOT NULL,answered_at INTEGER,UNIQUE(survey_id,enrollment_id));
    CREATE TABLE survey_answers(token TEXT PRIMARY KEY REFERENCES survey_invites(token),survey_id TEXT NOT NULL REFERENCES surveys(id),content_score INTEGER NOT NULL CHECK(content_score BETWEEN 1 AND 5),instructor_score INTEGER NOT NULL CHECK(instructor_score BETWEEN 1 AND 5),organization_score INTEGER NOT NULL CHECK(organization_score BETWEEN 1 AND 5),nps INTEGER NOT NULL CHECK(nps BETWEEN 0 AND 10),comment TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
    CREATE INDEX survey_answers_survey ON survey_answers(survey_id,created_at);
    PRAGMA user_version=24;
  `),
  );
}
