import {transaction} from './database.mjs';

// Esquema v29: Pauta (docs/PLAN_PAUTA.md). Trae al CRM lo que hacía el panel de tráfico («trafiquer») de IPCIL: captura diaria de la
// pauta y los mensajes acumulados de cada lanzamiento (una edición por vender), diagnóstico de si va a abrir, cola de acciones
// atendidas y decisiones del gerente. Aditivo: sólo tablas nuevas.
//  - ad_access: la función de «trafiquer» que concede administración (lee y captura las marcas que ya tiene asignadas).
//  - ad_launches: el día en que se lanzó la campaña de una edición (por omisión, su primera captura o la fecha de creación).
//  - ad_captures: acumulado de pauta y mensajes de Meta al cierre de un día (una fila por edición y día; capturar de nuevo corrige).
//  - ad_actions: «atendida» por día, con nota, compartida por quienes llevan la pauta.
//  - ad_decisions: instrucciones del gerente (subir, bajar o pausar pauta; apertura pospuesta o cerrada) y su aplicación.
export function migrateAds(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=29)return;
  transaction(db,()=>db.exec(`
    CREATE TABLE ad_access(user_id TEXT PRIMARY KEY REFERENCES users(id),granted_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    CREATE TABLE ad_launches(edition_id TEXT PRIMARY KEY REFERENCES editions(id),launched_on TEXT NOT NULL,updated_by TEXT REFERENCES users(id),updated_at INTEGER NOT NULL);
    CREATE TABLE ad_captures(edition_id TEXT NOT NULL REFERENCES editions(id),day TEXT NOT NULL,spend_cents INTEGER NOT NULL CHECK(spend_cents>=0),messages INTEGER NOT NULL CHECK(messages>=0),updated_by TEXT REFERENCES users(id),updated_at INTEGER NOT NULL,PRIMARY KEY(edition_id,day));
    CREATE TABLE ad_actions(edition_id TEXT NOT NULL REFERENCES editions(id),day TEXT NOT NULL,verdict TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',done_by TEXT REFERENCES users(id),done_at INTEGER NOT NULL,PRIMARY KEY(edition_id,day));
    CREATE TABLE ad_decisions(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),edition_id TEXT NOT NULL REFERENCES editions(id),
      type TEXT NOT NULL CHECK(type IN ('subir_pauta','bajar_pauta','pausar_pauta','posponer_apertura','cerrar_apertura')),reason TEXT NOT NULL DEFAULT '',budget_cents INTEGER,new_date TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','cancelled')),kpis TEXT NOT NULL DEFAULT '{}',client_ref TEXT UNIQUE,
      created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,applied_by TEXT REFERENCES users(id),applied_at INTEGER,applied_note TEXT NOT NULL DEFAULT '');
    CREATE INDEX ad_decisions_status ON ad_decisions(status,created_at);
    PRAGMA user_version=29;
  `));
}
