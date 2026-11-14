// Arrendamientos en las colas que no los tenían (docs/PLAN_RECEPCION_DURADERA.md). Sólo columnas que admiten NULL o
// traen DEFAULT: el código anterior sigue funcionando sobre una base ya migrada.
//
//   domain_deliveries, webhook_deliveries, jobs
//     lease_owner, lease_until   quién trabaja la fila y hasta cuándo. No hay estado nuevo: sigue «pending», con
//                                arrendamiento. Otro trabajador no la toma mientras el arrendamiento esté vigente.
//   messages
//     send_lease_until           marca duradera de «en vuelo» de un saliente de WhatsApp real: se pone antes de
//                                llamar al proveedor y se quita al anotar el resultado. Si el proceso muere en medio,
//                                queda puesta y delata un envío cuyo resultado se desconoce.
//     send_attempts              envíos seguidos de ese mensaje sin resultado anotado.
import { addColumn } from '../../named.mjs';

export default {
  name: 'queues/0001-leases',
  after: [],
  up(db) {
    for (const table of ['domain_deliveries', 'webhook_deliveries', 'jobs']) {
      addColumn(db, table, 'lease_owner', 'TEXT');
      addColumn(db, table, 'lease_until', 'INTEGER');
    }
    addColumn(db, 'messages', 'send_lease_until', 'INTEGER');
    addColumn(db, 'messages', 'send_attempts', 'INTEGER NOT NULL DEFAULT 0');
    // Sólo indexa los mensajes con un envío en vuelo o en duda: casi siempre, ninguno.
    db.exec('CREATE INDEX messages_send_lease ON messages(send_lease_until) WHERE send_lease_until IS NOT NULL');
  },
};
