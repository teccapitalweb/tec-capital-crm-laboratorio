import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { demoFlyers, courseArtwork } from './demo-catalog.mjs';

export const defaultEditionId = courseId => 'edition-' + courseId;
export function ensureDefaultEdition(db, course) {
  const id = defaultEditionId(course.id),
    now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO editions(id,brand_id,course_id,name,timezone,modality,price_cents,currency,status,legacy,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    course.brand_id,
    course.id,
    'Edición general',
    'America/Mexico_City',
    'online',
    course.price_cents,
    'MXN',
    'published',
    1,
    now,
    now,
  );
  return id;
}
export function migrateCatalogue(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 5) return;
  transaction(db, () => {
    db.exec(`CREATE TABLE editions (
      id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),course_id TEXT NOT NULL REFERENCES courses(id),
      name TEXT NOT NULL,starts_at INTEGER,ends_at INTEGER,timezone TEXT NOT NULL,instructor TEXT NOT NULL DEFAULT '',
      modality TEXT NOT NULL CHECK(modality IN ('online','in_person','hybrid')),location TEXT NOT NULL DEFAULT '',
      capacity INTEGER,available_seats INTEGER,info_url TEXT NOT NULL DEFAULT '',price_cents INTEGER NOT NULL CHECK(price_cents>=0),
      currency TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),legacy INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX editions_course ON editions(course_id,status,starts_at);
      CREATE TABLE promotions (
      id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),edition_id TEXT NOT NULL REFERENCES editions(id),name TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK(price_cents>=0),starts_at INTEGER NOT NULL,ends_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX promotions_edition ON promotions(edition_id,status,starts_at,ends_at);
      CREATE TABLE library_files (
      id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),filename TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,
      storage_name TEXT,builtin_id TEXT,created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
      CREATE TABLE flyers (
      id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),course_id TEXT NOT NULL REFERENCES courses(id),edition_id TEXT NOT NULL REFERENCES editions(id),
      promotion_id TEXT REFERENCES promotions(id),file_id TEXT NOT NULL REFERENCES library_files(id),title TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'all',expires_at INTEGER,status TEXT NOT NULL CHECK(status IN ('draft','approved','archived')),
      binding TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,approved_by TEXT REFERENCES users(id),approved_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE content_templates (
      id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),course_id TEXT REFERENCES courses(id),edition_id TEXT REFERENCES editions(id),
      flyer_id TEXT REFERENCES flyers(id),title TEXT NOT NULL,scenario TEXT NOT NULL,channel TEXT NOT NULL DEFAULT 'all',body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','approved','archived')),revision INTEGER NOT NULL DEFAULT 1,
      approved_by TEXT REFERENCES users(id),approved_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE catalogue_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,brand_id TEXT NOT NULL REFERENCES brands(id),entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL,
      revision INTEGER NOT NULL,action TEXT NOT NULL,actor_id TEXT REFERENCES users(id),snapshot TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX catalogue_history ON catalogue_events(entity_kind,entity_id,seq);
      ALTER TABLE opportunities ADD COLUMN edition_id TEXT REFERENCES editions(id);
      ALTER TABLE opportunities ADD COLUMN offer_snapshot TEXT;
      ALTER TABLE conversations ADD COLUMN edition_id TEXT REFERENCES editions(id);
      ALTER TABLE messages ADD COLUMN commercial_snapshot TEXT;
      DROP INDEX active_interest;
      DROP INDEX open_customer_course;`);
    for (const course of db.prepare('SELECT * FROM courses').all()) {
      const id = ensureDefaultEdition(db, course);
      db.prepare('UPDATE opportunities SET edition_id=? WHERE course_id=?').run(id, course.id);
      db.prepare('UPDATE conversations SET edition_id=? WHERE course_id=?').run(id, course.id);
      const item = demoFlyers.find(x => x.courseId === course.id);
      if (item && courseArtwork(course)) {
        const fileId = randomUUID(),
          flyerId = randomUUID(),
          now = Date.now();
        db.prepare(
          'INSERT INTO library_files(id,brand_id,filename,mime,size,builtin_id,created_at) VALUES(?,?,?,?,?,?,?)',
        ).run(fileId, course.brand_id, item.assetId + '.png', 'image/png', 0, item.assetId, now);
        db.prepare(
          `INSERT INTO flyers(id,brand_id,course_id,edition_id,file_id,title,status,binding,approved_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'approved',?,?,?,?)`,
        ).run(
          flyerId,
          course.brand_id,
          course.id,
          id,
          fileId,
          item.title + ' · demostración',
          JSON.stringify({ course: course.version, edition: 1, promotion: null }),
          now,
          now,
          now,
        );
      }
    }
    for (const brand of db.prepare('SELECT id FROM brands').all()) seedBrandTemplates(db, brand.id);
    db.exec(`CREATE UNIQUE INDEX active_interest ON opportunities(contact_id,course_id,edition_id) WHERE stage NOT IN ('ganada','perdida');
      CREATE UNIQUE INDEX open_customer_course ON conversations(customer_id,course_id,edition_id,channel) WHERE status!='resolved';
      PRAGMA user_version=5;`);
  });
}

export function seedBrandTemplates(db, brandId) {
  const scenarios = [
    [
      'info',
      'Información del curso',
      'Hola, {{nombre}}. Te comparto la información de {{curso}} con {{marca}}.\n\nEdición: {{edicion}}\nFecha: {{fecha}}\nModalidad: {{modalidad}}\nPrecio de ejemplo: {{precio}}\n\n¿Quieres conocer el temario o hablar con un asesor?\nLaboratorio: no se realizan cobros ni inscripciones reales.',
    ],
    ['syllabus', 'Temario', 'El temario de {{curso}} incluye:\n\n{{temario}}\n\nEdición: {{edicion}} · {{fecha}}'],
    [
      'schedule',
      'Fecha y docente',
      '{{curso}} · {{edicion}}\nFecha y horario: {{fecha}}\nDocente: {{docente}}\nModalidad: {{modalidad}}\nCupo disponible informativo: {{cupo}}',
    ],
    [
      'price',
      'Precio y promoción',
      '{{curso}} · {{edicion}}\nPrecio de ejemplo: {{precio}}\nPrecio regular: {{precio_regular}}\n{{promocion}}\nVigencia promocional: {{vigencia}}\n\nDatos de práctica. Un asesor puede ayudarte con el siguiente paso.',
    ],
    [
      'enroll',
      'Solicitud de inscripción',
      'Gracias por tu interés en {{curso}}, {{nombre}}. Un asesor continuará contigo para la edición {{edicion}} del {{fecha}}.\nEn este laboratorio no confirmamos pagos ni inscripciones reales.',
    ],
    [
      'followup',
      'Seguimiento',
      'Hola, {{nombre}}. ¿Pudiste revisar la información de {{curso}}? Puedo ayudarte con el temario, el horario de {{edicion}} o tus dudas.',
    ],
  ];
  for (const [scenario, title, body] of scenarios) {
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO content_templates(id,brand_id,title,scenario,body,status,approved_at,created_at,updated_at) VALUES(?,?,?,?,?,'approved',?,?,?)`,
    ).run('seed-' + brandId + '-' + scenario, brandId, title, scenario, body, now, now, now);
  }
}
