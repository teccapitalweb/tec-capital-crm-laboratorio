// Motor de difusiones con plantilla (docs/PLAN_MOTOR_DIFUSIONES.md; diseño de difusiones §3.2 y §5; conciliación,
// filas 37 y 39). Aditiva: las tablas que reconstruyó broadcasts/0001-foundations ya tienen la cola por destinatario.
//
//   campaign_settings     ajustes por marca de las difusiones con plantilla: ritmo por minuto, tope diario por número
//                         cuando no hay dato de la salud del número, horario de silencio para marketing, presupuesto
//                         mensual (0 = sin tope) y el porcentaje de fallos que detiene una campaña. La columna
//                         `enabled` de siempre sigue siendo el interruptor de la marca (apagado por omisión).
//   campaign_recipients   `client_ref`: la referencia de quien pide un envío suelto (sendOne, futura API): un reintento
//                         con la misma referencia no crea otro destinatario.
import { addColumn } from '../../named.mjs';

export default {
  name: 'broadcasts/0002-engine',
  after: [],
  up(db) {
    addColumn(db, 'campaign_settings', 'rate_per_minute', 'INTEGER NOT NULL DEFAULT 60');
    addColumn(db, 'campaign_settings', 'daily_cap', 'INTEGER NOT NULL DEFAULT 250');
    addColumn(db, 'campaign_settings', 'quiet_start', "TEXT NOT NULL DEFAULT '21:00'");
    addColumn(db, 'campaign_settings', 'quiet_end', "TEXT NOT NULL DEFAULT '08:00'");
    addColumn(db, 'campaign_settings', 'monthly_budget_cents', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'campaign_settings', 'fail_stop_pct', 'INTEGER NOT NULL DEFAULT 50');
    addColumn(db, 'campaign_recipients', 'client_ref', 'TEXT');
    db.exec(`
      CREATE UNIQUE INDEX campaign_recipients_client_ref ON campaign_recipients(client_ref) WHERE client_ref IS NOT NULL;
      CREATE INDEX campaign_recipients_outcome ON campaign_recipients(campaign_id,updated_at) WHERE state IN ('sent','delivered','read','failed');
    `);
  },
};
