// Importación de contactos por CSV (docs/PLAN_IMPORTAR_CONTACTOS.md; conciliación técnica, fila 14): un solo
// importador para todas sus puertas (CSV de contactos hoy; lista de una audiencia y la mudanza por API después).
//
//   contact_imports      una fila por archivo subido: dónde quedó guardado (privado, en DATA_DIR/imports; se borra a
//                        los 7 días de terminar), cómo se leyó (codificación, separador, encabezados y dónde empiezan
//                        los datos), el mapeo de columnas y las opciones (consentimiento declarado incluido), el
//                        estado y el informe. `revision` cambia con cada mapeo: la vista previa y la importación se
//                        atan a una revisión. `source` (csv|api|sheet) y `audience_id` quedan para las otras puertas.
//   contact_import_rows  el resultado de cada fila en la vista previa (`preview`) y al importar (`apply`): acción,
//                        contacto y, si hubo problema, su código, el mensaje y el detalle (que se vacía con el archivo).
//
// Y un índice para encontrar un contacto por su correo dentro de la marca (respaldo de la clave de teléfono).
export default {
  name: 'contact-import/0001-imports',
  after: ['jobs/0001-background-jobs', 'identity/0001-phone-key'],
  up(db) {
    db.exec(`
      CREATE TABLE contact_imports(
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL REFERENCES brands(id),
        source TEXT NOT NULL DEFAULT 'csv',
        filename TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        storage_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        encoding TEXT NOT NULL,
        delimiter TEXT NOT NULL,
        rows INTEGER NOT NULL DEFAULT 0,
        header TEXT NOT NULL DEFAULT '[]',
        data_offset INTEGER NOT NULL DEFAULT 0,
        data_line INTEGER NOT NULL DEFAULT 1,
        mapping TEXT NOT NULL DEFAULT '{}',
        options TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL DEFAULT 'uploaded'
          CHECK(state IN ('uploaded','validating','validated','applying','done','failed','cancelled')),
        report TEXT NOT NULL DEFAULT '{}',
        validated_revision INTEGER,
        job_id TEXT,
        audience_id TEXT,
        client_ref TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_by TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER,
        purged_at INTEGER,
        UNIQUE(brand_id, client_ref)
      );
      CREATE INDEX contact_imports_brand ON contact_imports(brand_id, created_at);
      CREATE INDEX contact_imports_file ON contact_imports(brand_id, sha256);
      CREATE TABLE contact_import_rows(
        import_id TEXT NOT NULL REFERENCES contact_imports(id),
        phase TEXT NOT NULL CHECK(phase IN ('preview','apply')),
        row INTEGER NOT NULL,
        line INTEGER NOT NULL,
        action TEXT NOT NULL,
        contact_id TEXT,
        problem TEXT,
        message TEXT,
        detail TEXT,
        PRIMARY KEY(import_id, phase, row)
      );
      CREATE INDEX contact_import_rows_action ON contact_import_rows(import_id, phase, action, row);
      CREATE INDEX contact_import_rows_contact ON contact_import_rows(contact_id) WHERE contact_id IS NOT NULL;
      CREATE INDEX contacts_email_key ON contacts(brand_id, lower(email)) WHERE email != '';
    `);
  },
};
