import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function openDatabase(directory) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(resolve(directory, 'laboratorio.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 1) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('customer','agent','admin')),
        test_number INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
      );
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE TABLE brands (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT 'Marca de prueba', created_at INTEGER NOT NULL);
      CREATE TABLE courses (
        id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id), title TEXT NOT NULL,
        price_cents INTEGER NOT NULL CHECK(price_cents>=0), date_label TEXT NOT NULL,
        syllabus TEXT NOT NULL, welcome TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES users(id), brand_id TEXT NOT NULL REFERENCES brands(id),
        course_id TEXT NOT NULL REFERENCES courses(id), channel TEXT NOT NULL CHECK(channel IN ('whatsapp','instagram','facebook')),
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','waiting','resolved')),
        stage TEXT NOT NULL DEFAULT 'nuevo' CHECK(stage IN ('nuevo','interesado','inscripcion','inscrito')),
        bot_enabled INTEGER NOT NULL DEFAULT 1, assigned_to TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX conversations_customer ON conversations(customer_id,updated_at);
      CREATE INDEX conversations_brand ON conversations(brand_id,updated_at);
      CREATE UNIQUE INDEX open_customer_course ON conversations(customer_id,course_id,channel) WHERE status!='resolved';
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        owner_id TEXT NOT NULL REFERENCES users(id), filename TEXT NOT NULL, storage_name TEXT NOT NULL,
        mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id), sender_id TEXT REFERENCES users(id),
        sender_kind TEXT NOT NULL CHECK(sender_kind IN ('customer','agent','automation','system')),
        text TEXT NOT NULL DEFAULT '', attachment_id TEXT REFERENCES attachments(id),
        flyer_course_id TEXT REFERENCES courses(id), flyer_snapshot TEXT, client_ref TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, read_at INTEGER
      );
      CREATE INDEX messages_conversation ON messages(conversation_id,seq);
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
        due_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','cancelled'))
      );
      CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT NOT NULL, entity_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      PRAGMA user_version=1;
    COMMIT;`);
  }
  if (!db.prepare('SELECT id FROM brands LIMIT 1').get()) {
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [id,name,description] of [['globalvet','GlobalVet','Capacitación veterinaria'],['odonteck','OdonTeck','Formación odontológica'],['dermalysse','Dermalysse','Formación en cuidado de la piel']]) {
        db.prepare('INSERT INTO brands VALUES(?,?,?,?)').run(id,name,description,now);
      }
      for (const [id,brand,title,price,syllabus] of [
        ['aves','globalvet','Plan sanitario para aves',37900,'Prevención de enfermedades\nBioseguridad en la granja\nIntroducción a la vacunación\nPreguntas y casos de estudio'],
        ['odontologia','odonteck','Actualización en odontología',49900,'Fundamentos y actualización\nProtocolos de atención\nAnálisis de casos\nPreguntas con el docente'],
        ['piel','dermalysse','Fundamentos de la piel',39900,'Anatomía y funciones de la piel\nConceptos de cuidado\nRevisión de casos\nPreguntas frecuentes']
      ]) {
        db.prepare('INSERT INTO courses(id,brand_id,title,price_cents,date_label,syllabus,welcome,updated_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(id,brand,title,price,'Fecha de práctica por confirmar',syllabus,'Hola, {{nombre}}. Te comparto la información de {{curso}}. ¿Quieres conocer el temario, el precio o cómo inscribirte?',now);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result=fn(); db.exec('COMMIT'); return result; }
  catch(error) { db.exec('ROLLBACK'); throw error; }
}
