// Recorridos de conversación (docs/PLAN_RECORRIDOS.md; diseño de automatización §6.1; conciliación, filas 2 y N-4).
// Aditiva: tablas nuevas, sin tocar las del flujo de bienvenida (welcome_flows, flow_runs).
//
//   chatflows            un recorrido por fila: nombre, estado (draft, active, paused, archived), BORRADOR en edición
//                        (grafo, ajustes e inicio) y la versión publicada que está en servicio. `revision` es la de
//                        expectedRevision: sube con cada cambio.
//   chatflow_versions    versiones publicadas, inmutables: lo que corre una sesión es la versión con la que empezó.
//   chatflow_sessions    una sesión por conversación mientras está viva (índice único parcial); `seq` sube con cada
//                        paso ejecutado y es el candado optimista y la base de las claves de idempotencia.
//   chatflow_events      la bitácora de cada sesión, paso por paso.
export default {
  name: 'chatflows/0001-chatflows',
  after: [],
  up(db) {
    db.exec(`
      CREATE TABLE chatflows(
        id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id), name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','archived')),
        draft TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}', start TEXT NOT NULL DEFAULT '{"type":"manual"}',
        revision INTEGER NOT NULL DEFAULT 1, published_version INTEGER,
        client_ref TEXT UNIQUE, created_by TEXT REFERENCES users(id), updated_by TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX chatflows_brand ON chatflows(brand_id,status,updated_at);
      CREATE TABLE chatflow_versions(
        flow_id TEXT NOT NULL REFERENCES chatflows(id), version INTEGER NOT NULL,
        brand_id TEXT NOT NULL REFERENCES brands(id), name TEXT NOT NULL, graph TEXT NOT NULL,
        settings TEXT NOT NULL, start TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
        published_by TEXT REFERENCES users(id), published_at INTEGER NOT NULL,
        PRIMARY KEY(flow_id,version));
      CREATE TABLE chatflow_sessions(
        id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id),
        flow_id TEXT NOT NULL REFERENCES chatflows(id), flow_version INTEGER NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id), course_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('running','waiting','delayed','ended')),
        node_id TEXT, seq INTEGER NOT NULL DEFAULT 0, vars TEXT NOT NULL DEFAULT '{}', waiting TEXT,
        steps INTEGER NOT NULL DEFAULT 0, unanswered INTEGER NOT NULL DEFAULT 0,
        started_by TEXT NOT NULL DEFAULT 'message', source_key TEXT,
        expires_at INTEGER, outcome TEXT, end_node_id TEXT, last_input_message_id TEXT,
        started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER);
      CREATE UNIQUE INDEX chatflow_session_active ON chatflow_sessions(conversation_id) WHERE state!='ended';
      CREATE UNIQUE INDEX chatflow_session_source ON chatflow_sessions(source_key) WHERE source_key IS NOT NULL;
      CREATE INDEX chatflow_sessions_flow ON chatflow_sessions(brand_id,flow_id,started_at);
      CREATE INDEX chatflow_sessions_conversation ON chatflow_sessions(conversation_id,flow_id,started_at);
      CREATE TABLE chatflow_events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, brand_id TEXT NOT NULL REFERENCES brands(id),
        session_id TEXT NOT NULL REFERENCES chatflow_sessions(id), flow_id TEXT NOT NULL, flow_version INTEGER NOT NULL,
        node_id TEXT, node_type TEXT, course_id TEXT,
        event TEXT NOT NULL CHECK(event IN ('start','enter','exit','wait','input','miss','error','timeout','end')),
        port TEXT, detail TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX chatflow_events_session ON chatflow_events(session_id,seq);
      CREATE INDEX chatflow_events_flow ON chatflow_events(brand_id,flow_id,seq);
    `);
  },
};
