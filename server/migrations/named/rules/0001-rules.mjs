// Reglas por mensaje (docs/PLAN_REGLAS.md; diseño de automatización §5.1; conciliación, filas 48 y N-3).
// Aditiva: tablas nuevas, sin tocar otras.
//
//   automation_rules          una regla por fila: «cuando un mensaje coincide con estas palabras y estas condiciones,
//                             haz estas acciones». Estado (draft, active, paused, archived), lugar en la lista de la
//                             marca (`position`: menor = se evalúa antes), `revision` para expectedRevision y contador.
//   automation_rule_runs      bitácora: una fila por regla y por mensaje (UNIQUE(rule_id, source_key)), así un trabajo
//                             que se repite no repite la regla. Se purga a los 90 días.
//   automation_rule_settings  por marca: candado del orden de la lista y tope de respuestas de reglas seguidas.
export default {
  name: 'rules/0001-rules',
  after: [],
  up(db) {
    db.exec(`
      CREATE TABLE automation_rules(
        id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id), title TEXT NOT NULL,
        trigger TEXT NOT NULL, definition TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','archived')),
        position INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        executions INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER, last_error TEXT,
        client_ref TEXT UNIQUE, created_by TEXT REFERENCES users(id), updated_by TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX automation_rules_brand ON automation_rules(brand_id,status,position);
      CREATE TABLE automation_rule_runs(
        id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES automation_rules(id), rule_revision INTEGER NOT NULL,
        brand_id TEXT NOT NULL REFERENCES brands(id), conversation_id TEXT REFERENCES conversations(id),
        source_key TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('executed','partial','skipped','failed')),
        voice INTEGER NOT NULL DEFAULT 0, actions TEXT NOT NULL DEFAULT '[]', reason TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(rule_id,source_key));
      CREATE INDEX automation_rule_runs_rule ON automation_rule_runs(rule_id,created_at);
      CREATE INDEX automation_rule_runs_conversation ON automation_rule_runs(conversation_id,rule_id,created_at);
      CREATE INDEX automation_rule_runs_brand ON automation_rule_runs(brand_id,created_at);
      CREATE TABLE automation_rule_settings(
        brand_id TEXT PRIMARY KEY REFERENCES brands(id), order_revision INTEGER NOT NULL DEFAULT 0,
        max_consecutive INTEGER NOT NULL DEFAULT 3, revision INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT REFERENCES users(id), updated_at INTEGER NOT NULL);
    `);
  },
};
