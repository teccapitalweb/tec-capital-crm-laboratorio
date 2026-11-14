// Bandeja de entrada de webhooks (docs/PLAN_RECEPCION_DURADERA.md). La petición del proveedor guarda aquí cada evento
// normalizado y responde; un trabajador lo procesa aparte, con arrendamiento y reintentos (server/app/webhook-inbox.mjs).
//
//   kind      clase de webhook ('channel', 'payment'…). SIN restricción en la tabla: la lista se valida en código, para
//             que un tipo nuevo no obligue a reconstruirla.
//   lane      carril de orden: dentro de un carril los eventos se procesan de uno en uno y en orden de llegada.
//   payload   el evento normalizado en JSON; se vacía en cuanto se procesa.
//   state     pending → reserved → done | failed. Una fila «failed» conserva su carga un tiempo para poder reprocesarla.
export default {
  name: 'inbox/0001-webhook-inbox',
  after: [],
  up(db) {
    db.exec(`
      CREATE TABLE webhook_inbox(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        event_id TEXT NOT NULL,
        type TEXT NOT NULL,
        lane TEXT NOT NULL,
        payload TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','reserved','done','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 12,
        next_attempt_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_until INTEGER,
        result TEXT,
        error TEXT,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        done_at INTEGER,
        UNIQUE(provider,event_id)
      );
      CREATE INDEX webhook_inbox_due ON webhook_inbox(next_attempt_at,seq) WHERE state='pending';
      CREATE INDEX webhook_inbox_lane ON webhook_inbox(lane,seq) WHERE state IN ('pending','reserved');
      CREATE INDEX webhook_inbox_leases ON webhook_inbox(lease_until) WHERE state='reserved';
      CREATE INDEX webhook_inbox_done ON webhook_inbox(done_at) WHERE state='done';
      CREATE INDEX webhook_inbox_failed ON webhook_inbox(updated_at) WHERE state='failed';
    `);
  },
};
