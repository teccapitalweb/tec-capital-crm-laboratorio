// Identidad por identificador de usuario de WhatsApp (docs/PLAN_IDENTIDAD_SIN_TELEFONO.md, incremento I-2).
//
// La lógica vive en server/lib/identity.mjs y la usa el entrante de WhatsApp (server/whatsapp.mjs). Este módulo:
//   - le presta la fusión interna de contactos (para «el teléfono apareció» y la fusión segura de clientes);
//   - rellena por trozos lo que ya existe (trabajo `identity.backfill`: teléfonos de wa_identities → identity_keys y
//     el último mensaje de cada persona → wa_peer_state), sin detener el arranque;
//   - al arrancar con WhatsApp real activo, vuelve a pasar por el entrante lo que la versión anterior dejó en
//     cuarentena «no_phone» (personas que escribieron sólo con su identificador de usuario);
//   - y estas rutas:
//
//   GET  /api/identity                       administración: personas con y sin teléfono, vínculos, conflictos y
//                                            cuarentena (sin textos ni identificadores)
//   POST /api/identity/quarantine/retry      administración: reprocesa los entrantes en cuarentena «no_phone» y
//                                            «no_identifier» que conservan su contenido → {retried}
//   GET  /api/identity/contacts/<id>         equipo de la marca (contacts.view): bloque «WhatsApp» del contacto. El
//                                            teléfono, enmascarado para quien no tiene contacts.phone; el identificador
//                                            completo, sólo para administración.
import { sharedJobRunner } from '../../app/background-jobs.mjs';
import { backfillStep } from '../../lib/identity.mjs';

const CONTACT = /^\/api\/identity\/contacts\/([A-Za-z0-9-]{1,64})$/;
const HELD = "state='failed' AND error IN ('no_phone','no_identifier') AND payload IS NOT NULL";

export default {
  name: 'identity',
  create(host) {
    const { db, fail, access } = host;
    const services = host.services;
    const identity = services.whatsapp?.identity;
    if (!identity) throw new Error('El servicio de WhatsApp no expone la identidad.');
    identity.use({ contacts: services.contacts });

    // Relleno de lo existente: un solo trabajo por instalación (clientRef fijo); repetirlo no duplica nada.
    const runner = sharedJobRunner(host);
    runner.define('identity.backfill', {
      step: (job, { limit, now }) => backfillStep(db, job.cursor, limit, now),
    });
    host.transaction(db, () => runner.enqueue({ kind: 'identity.backfill', clientRef: 'v1' }));

    // Reproceso de la cuarentena: vuelve a pendiente cada fila y el trabajador de la bandeja la pasa por el entrante.
    function retryHeld(errors) {
      const inbox = services.connectors.inbox;
      const rows = db
        .prepare(
          `SELECT seq FROM webhook_inbox WHERE state='failed' AND error IN (${errors.map(() => '?').join(',')}) AND payload IS NOT NULL ORDER BY seq LIMIT 500`,
        )
        .all(...errors);
      let retried = 0;
      for (const row of rows) {
        try {
          inbox.retry(row.seq);
          retried++;
        } catch {
          // otra petición la reprocesó a la vez: ya no está fallida
        }
      }
      return retried;
    }
    // Sólo con WhatsApp real activo: si no, el entrante se anotaría como «apagado» y se perdería.
    if (services.connectors.metaLive()) retryHeld(['no_phone']);

    function contactView(user, id) {
      const c = db.prepare('SELECT id,brand_id,phone,source_user_id FROM contacts WHERE id=?').get(id);
      if (!c) throw fail(404, 'Contacto no disponible.', { code: 'not_found' });
      access.require(user, 'contacts.view', c.brand_id);
      const keys = c.source_user_id
        ? identity.keysView(c.source_user_id, { full: access.can(user, 'contacts.phone', { company: true }) })
        : { hasPhone: false, hasBsuid: false, username: '', bsuidHint: null, phoneSeenAt: null };
      const real = c.source_user_id
        ? Boolean(
            db
              .prepare('SELECT 1 FROM conversations WHERE customer_id=? AND brand_id=? AND wa_number IS NOT NULL')
              .get(c.source_user_id, c.brand_id),
          )
        : false;
      return {
        whatsapp: {
          phone: access.phone(user, c.phone, c.brand_id) || '',
          username: keys.username,
          bsuidHint: keys.bsuidHint,
          ...(keys.bsuid !== undefined ? { bsuid: keys.bsuid } : {}),
          phoneSeenAt: keys.phoneSeenAt,
          hasPhone: Boolean(c.phone),
          real,
        },
      };
    }

    async function handle(req, res, path, user) {
      if (path === '/api/identity' && req.method === 'GET') {
        host.requireAdmin(user);
        host.json(res, 200, { identity: identity.stats() });
        return true;
      }
      if (path === '/api/identity/quarantine/retry' && req.method === 'POST') {
        host.requireAdmin(user);
        host.rate('identity-retry:' + user.id, 12);
        const retried = retryHeld(['no_phone', 'no_identifier']);
        host.audit(user, 'identity.quarantine.retry', String(retried));
        host.json(res, 200, {
          retried,
          held: db.prepare(`SELECT count(*) n FROM webhook_inbox WHERE ${HELD}`).get().n,
        });
        return true;
      }
      const match = CONTACT.exec(path);
      if (match && req.method === 'GET') {
        host.requireStaff(user);
        host.json(res, 200, contactView(user, match[1]));
        return true;
      }
      return false;
    }
    return { handle, retryHeld };
  },
};
