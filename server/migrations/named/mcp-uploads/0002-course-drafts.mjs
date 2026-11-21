// Cursos en borrador del conector de Claude (docs/PLAN_MCP_CLAUDE.md, «Dar de alta un curso»). Un curso nuevo NO entra
// al catálogo hasta que una persona aprueba la propuesta «dar_de_alta_curso»: mientras tanto vive aquí, en una tabla
// propia que no lee ninguna parte del catálogo, del asistente ni de la experiencia del cliente.
//
//   mcp_course_drafts   marca; título, temario y bienvenida; los datos de la apertura inicial (nombre, inicio y fin en
//                       UTC con su zona IANA, docente, modalidad, lugar, enlace, cupo, precio en centavos y moneda); el
//                       archivo de imagen ya subido (opcional, de la biblioteca de la marca); de dónde vino (llave u
//                       OAuth), quién lo firmó y su clientRef; revisión; estado (borrador → dado de alta, o descartado)
//                       y, al darlo de alta, los ids creados (curso, apertura, imagen). Esos ids se anotan paso a paso:
//                       si el alta falla a medias, un reintento sigue desde donde quedó y no repite lo hecho.
//
// Va en el área «mcp-uploads» porque es el mismo frente (dar de alta el catálogo de una marca por el conector) y la
// dirección de subida de la imagen apunta a un borrador: se le añade aquí `course_draft_id`.
export default {
  name: 'mcp-uploads/0002-course-drafts',
  after: ['mcp-uploads/0001-upload-tokens'],
  up(db) {
    db.exec(`
      CREATE TABLE mcp_course_drafts(
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL REFERENCES brands(id),
        title TEXT NOT NULL,
        syllabus TEXT NOT NULL DEFAULT '',
        welcome TEXT NOT NULL DEFAULT '',
        edition_name TEXT NOT NULL DEFAULT '',
        starts_at INTEGER,
        ends_at INTEGER,
        timezone TEXT NOT NULL,
        instructor TEXT NOT NULL DEFAULT '',
        modality TEXT NOT NULL DEFAULT 'online' CHECK(modality IN ('online','in_person','hybrid')),
        location TEXT NOT NULL DEFAULT '',
        info_url TEXT NOT NULL DEFAULT '',
        capacity INTEGER,
        price_cents INTEGER CHECK(price_cents IS NULL OR price_cents >= 0),
        currency TEXT NOT NULL DEFAULT 'MXN',
        file_id TEXT REFERENCES library_files(id),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('key','oauth')),
        source_id TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        client_ref TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','created','discarded')),
        course_id TEXT REFERENCES courses(id),
        edition_id TEXT REFERENCES editions(id),
        flyer_id TEXT REFERENCES flyers(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX mcp_course_drafts_ref ON mcp_course_drafts(brand_id, source_kind, source_id, client_ref);
      CREATE INDEX mcp_course_drafts_source ON mcp_course_drafts(brand_id, source_kind, source_id, status, updated_at);
      CREATE INDEX mcp_course_drafts_brand ON mcp_course_drafts(brand_id, status);
      ALTER TABLE mcp_upload_tokens ADD COLUMN course_draft_id TEXT REFERENCES mcp_course_drafts(id);
      CREATE INDEX mcp_upload_tokens_draft ON mcp_upload_tokens(course_draft_id);
    `);
  },
};
