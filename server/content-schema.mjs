import {transaction} from './database.mjs';

// Esquema v23 (Fase 2 · bloque 2.6 Contenido). Plantillas por evento: cada marca elige qué plantilla aprobada se usa en
// cada hecho del ciclo (bienvenida por anuncio, pago pendiente, pago confirmado, recordatorio de sesión, grabación
// disponible, certificado listo); funciones de contenido por persona (diseño sube, aprobación aprueba; venta usa);
// variantes redactadas por el adaptador de IA que una persona acepta como borrador; fichas SVG generadas desde el
// catálogo con caché por versión.
export function migrateContent(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=23)return;
  transaction(db,()=>db.exec(`
    CREATE TABLE content_access(user_id TEXT PRIMARY KEY REFERENCES users(id),can_design INTEGER NOT NULL DEFAULT 0,can_approve INTEGER NOT NULL DEFAULT 0,granted_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    CREATE TABLE event_templates(brand_id TEXT NOT NULL REFERENCES brands(id),event TEXT NOT NULL,template_id TEXT REFERENCES content_templates(id),enabled INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT REFERENCES users(id),updated_at INTEGER NOT NULL,PRIMARY KEY(brand_id,event));
    CREATE TABLE template_variants(id TEXT PRIMARY KEY,template_id TEXT NOT NULL REFERENCES content_templates(id),brand_id TEXT NOT NULL REFERENCES brands(id),tone TEXT NOT NULL,body TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN ('draft','accepted','rejected')),created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,decided_by TEXT REFERENCES users(id),decided_at INTEGER,accepted_template_id TEXT REFERENCES content_templates(id));
    CREATE INDEX template_variants_template ON template_variants(template_id,created_at);
    CREATE TABLE content_sheets(edition_id TEXT PRIMARY KEY REFERENCES editions(id),version_key TEXT NOT NULL,svg TEXT NOT NULL,created_at INTEGER NOT NULL);
    PRAGMA user_version=23;
  `));
}
