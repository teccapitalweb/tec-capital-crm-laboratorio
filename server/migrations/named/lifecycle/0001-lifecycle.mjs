// Ciclo de vida de la conversación (docs/PLAN_CICLO_DE_VIDA.md; diseño de bandeja §2.2, conciliación filas 20 a 22).
//
// Tres columnas de los cimientos de la bandeja (M-A) que el ciclo de vida necesita y todavía no existían:
//   last_customer_at, last_outbound_at   último mensaje de la persona y último saliente (persona o asistente)
//   window_until                          last_customer_at + 24 h: reflejo indexable de la ventana. La regla de envío
//                                         sigue en channel.windowOf(); el reloj de expiración la vuelve a comprobar ahí.
// El resto de M-A (activity_at, vista previa, no leídos…) lo añade su incremento con addColumn, que no repite columnas.
//
// El eje nuevo, «estado de la conversación» (M-B), separado de «quién atiende» (status + bot_enabled + assigned_to):
//   conversations.state   open | pending | solved | expired | awaiting | blocked
//   conversation_cycles   ciclos de atención, la ÚNICA tabla con autoridad (fila 21): de quien la abre a quien la cierra
//   inbox_settings        ajustes por marca; sin fila, los valores por omisión (todo como hoy, sin expiración)
//
// Relleno: aquí sólo lo barato y por conjunto (estado y origen de cada conversación). Los ciclos de las conversaciones
// que ya existían, sus contadores y las tres columnas de M-A los calcula un trabajo por trozos
// (`lifecycle.backfill`, server/modules/lifecycle/module.mjs) para no bloquear el arranque.
import { addColumn } from '../../named.mjs';

export default {
  name: 'lifecycle/0001-lifecycle',
  after: [], // sólo toca conversations, brands, users y opportunities (escalera)
  up(db) {
    addColumn(db, 'conversations', 'last_customer_at', 'INTEGER');
    addColumn(db, 'conversations', 'last_outbound_at', 'INTEGER');
    addColumn(db, 'conversations', 'window_until', 'INTEGER');
    addColumn(
      db,
      'conversations',
      'state',
      "TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','pending','solved','expired','awaiting','blocked'))",
    );
    addColumn(db, 'conversations', 'state_since', 'INTEGER');
    addColumn(
      db,
      'conversations',
      'resolved_by',
      "TEXT CHECK(resolved_by IS NULL OR resolved_by IN ('agent','automation'))",
    );
    addColumn(db, 'conversations', 'origin', "TEXT NOT NULL DEFAULT 'inbound'"); // inbound|ad|broadcast|outbound|api|import|lab
    addColumn(db, 'conversations', 'origin_ref', 'TEXT');
    addColumn(db, 'conversations', 'cycle_id', 'TEXT');
    addColumn(db, 'conversations', 'cycle_count', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'conversations', 'previous_id', 'TEXT REFERENCES conversations(id)');
    addColumn(db, 'conversations', 'last_campaign_id', 'TEXT');
    addColumn(db, 'conversations', 'last_campaign_at', 'INTEGER');
    db.exec(`
      CREATE TABLE conversation_cycles(
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        brand_id TEXT NOT NULL REFERENCES brands(id),
        number INTEGER NOT NULL,
        opened_at INTEGER NOT NULL,
        opened_by TEXT NOT NULL CHECK(opened_by IN ('customer','agent','automation','api','import','repair')),
        origin TEXT NOT NULL,
        origin_ref TEXT,
        opportunity_id TEXT REFERENCES opportunities(id),
        first_assigned_at INTEGER,
        first_response_at INTEGER,
        first_response_by TEXT CHECK(first_response_by IS NULL OR first_response_by IN ('agent','automation')),
        first_human_at INTEGER,
        customer_messages INTEGER NOT NULL DEFAULT 0,
        human_messages INTEGER NOT NULL DEFAULT 0,
        automation_messages INTEGER NOT NULL DEFAULT 0,
        pending_since INTEGER,
        pending_ms INTEGER NOT NULL DEFAULT 0,
        closed_at INTEGER,
        close_kind TEXT CHECK(close_kind IS NULL OR close_kind IN ('solved_agent','solved_automation','expired','blocked','repair')),
        closed_by TEXT REFERENCES users(id),
        handler_at_close TEXT CHECK(handler_at_close IS NULL OR handler_at_close IN ('agent','automation','queue')),
        assignee_at_close TEXT REFERENCES users(id),
        team_at_close TEXT,
        missed INTEGER NOT NULL DEFAULT 0,
        missed_strict INTEGER NOT NULL DEFAULT 0,
        expired_while_pending INTEGER NOT NULL DEFAULT 0,
        backfilled INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX conversation_cycles_number ON conversation_cycles(conversation_id,number);
      CREATE UNIQUE INDEX conversation_cycles_open ON conversation_cycles(conversation_id) WHERE closed_at IS NULL;
      CREATE INDEX conversation_cycles_opened ON conversation_cycles(brand_id,opened_at);
      CREATE INDEX conversation_cycles_closed ON conversation_cycles(brand_id,closed_at) WHERE closed_at IS NOT NULL;
      CREATE TABLE inbox_settings(
        brand_id TEXT PRIMARY KEY REFERENCES brands(id),
        auto_expire INTEGER NOT NULL DEFAULT 0 CHECK(auto_expire IN (0,1)),
        auto_expire_at INTEGER,
        thread_mode TEXT NOT NULL DEFAULT 'episodes' CHECK(thread_mode IN ('episodes','continuous')),
        reopen_policy TEXT NOT NULL DEFAULT 'assistant' CHECK(reopen_policy IN ('assistant','last_owner','queue')),
        reopen_owner_days INTEGER NOT NULL DEFAULT 30,
        attribution_days INTEGER NOT NULL DEFAULT 7,
        missed_notify INTEGER NOT NULL DEFAULT 1 CHECK(missed_notify IN (0,1)),
        revision INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT REFERENCES users(id),
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX conversations_state ON conversations(brand_id,state,updated_at DESC,id DESC);
      CREATE INDEX conversations_window ON conversations(window_until) WHERE state IN ('open','pending');
    `);
    // Relleno por conjunto: una resuelta es «Resuelta» por una persona; el resto queda «Abierta» (no se expira nada al
    // migrar). Origen: anuncio si llegó con uno, laboratorio si no tiene número real, si no, entrante.
    db.exec(`
      UPDATE conversations SET state='solved',resolved_by='agent',state_since=updated_at WHERE status='resolved';
      UPDATE conversations SET state_since=created_at WHERE state_since IS NULL;
      UPDATE conversations SET
        origin=CASE
          WHEN referral IS NOT NULL AND json_valid(referral) AND json_extract(referral,'$.source')='ad' THEN 'ad'
          WHEN wa_number IS NULL THEN 'lab'
          ELSE 'inbound' END,
        origin_ref=CASE WHEN referral IS NOT NULL AND json_valid(referral) THEN json_extract(referral,'$.adId') END;
    `);
  },
};
