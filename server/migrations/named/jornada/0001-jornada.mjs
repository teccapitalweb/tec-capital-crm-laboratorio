// Jornada simulada (docs/PLAN_JORNADA_SIMULADA.md): un día de trabajo con clientes de mentira que llegan a goteo durante
// horas. Tres tablas:
//   jornada_runs      la jornada: marca, cuántos y en cuánto tiempo, ritmo, perfiles, quién atiende, de qué avisar, estado
//                     y la demo del simulador (simulator_runs) a la que se suman sus clientes.
//   jornada_arrivals  cada llegada planeada: a qué hora, con qué perfil y canal; cuando llega, su actor y conversación.
//   jornada_alerts    lo que la supervisión detecta (sin respuesta, el asistente no supo, pasó a persona sin motivo,
//                     la persona tarda, cliente molesto), una por conversación y clase, con quién la resolvió.
export default {
  name: 'jornada/0001-jornada',
  after: [],
  up(db) {
    db.exec(`
      CREATE TABLE jornada_runs(
        id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL REFERENCES brands(id),
        title TEXT NOT NULL,
        count INTEGER NOT NULL,
        minutes INTEGER NOT NULL,
        rhythm TEXT NOT NULL CHECK(rhythm IN ('goteo','parejo','rafagas')),
        pace TEXT NOT NULL DEFAULT 'lenta',
        personas TEXT NOT NULL,
        assignee_id TEXT REFERENCES users(id),
        alerts TEXT NOT NULL DEFAULT '{}',
        simulator_run_id TEXT REFERENCES simulator_runs(id),
        state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','running','paused','finished','archived')),
        starts_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        paused_at INTEGER,
        paused_ms INTEGER NOT NULL DEFAULT 0,
        finished_at INTEGER,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL);
      CREATE INDEX jornada_runs_brand ON jornada_runs(brand_id,state,created_at);
      CREATE TABLE jornada_arrivals(
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES jornada_runs(id),
        planned_at INTEGER NOT NULL,
        persona TEXT NOT NULL,
        channel TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','arrived','skipped')),
        actor_id TEXT REFERENCES simulator_actors(id),
        user_id TEXT REFERENCES users(id),
        arrived_at INTEGER);
      CREATE INDEX jornada_arrivals_due ON jornada_arrivals(run_id,state,planned_at);
      CREATE TABLE jornada_alerts(
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES jornada_runs(id),
        brand_id TEXT NOT NULL REFERENCES brands(id),
        kind TEXT NOT NULL,
        conversation_id TEXT REFERENCES conversations(id),
        text TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','resolved')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_by TEXT REFERENCES users(id),
        UNIQUE(run_id,kind,conversation_id));
      CREATE INDEX jornada_alerts_run ON jornada_alerts(run_id,state,created_at);
    `);
  },
};
