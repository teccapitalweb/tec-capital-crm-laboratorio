// Trabajos largos por trozos (docs/PLAN_IMPORTAR_CONTACTOS.md): el reloj del ejecutor de server/app/background-jobs.mjs
// y dos rutas para ver o cancelar un trabajo. Los demás módulos declaran sus tipos y encolan con el mismo ejecutor:
// sharedJobRunner(host).define(…) al crearse y .enqueue(…) al usarlo (o host.module('jobs'), que expone lo mismo).
//
//   GET  /api/jobs/<id>          → {job}   (permiso del tipo de trabajo sobre su marca)
//   POST /api/jobs/<id>/cancel   → {job}
import { sharedJobRunner } from '../../app/background-jobs.mjs';

const ID = /^\/api\/jobs\/([0-9a-f-]{36})(\/cancel)?$/;

export default {
  name: 'jobs',
  create(host) {
    const runner = sharedJobRunner(host);

    function locate(user, id) {
      const job = runner.get(id);
      const permission = job && runner.definition(job.kind)?.permission;
      if (!job || !job.brand_id) throw host.fail(404, 'Trabajo no disponible.', { code: 'not_found' });
      if (permission) host.access.require(user, permission, job.brand_id);
      else {
        host.requireAdmin(user);
        host.access.require(user, 'contacts.view', job.brand_id);
      }
      return job;
    }

    async function handle(req, res, path, user) {
      const match = ID.exec(path);
      if (!match) return false;
      host.requireStaff(user);
      const job = locate(user, match[1]);
      if (req.method === 'GET' && !match[2]) {
        host.json(res, 200, { job: runner.view(job) });
        return true;
      }
      if (req.method === 'POST' && match[2]) {
        const after = host.transaction(host.db, () => runner.cancel(job.id));
        host.audit(user, 'job.cancel', job.id);
        host.json(res, 200, { job: runner.view(after) });
        return true;
      }
      return false;
    }

    return {
      handle,
      define: runner.define,
      enqueue: runner.enqueue,
      cancel: runner.cancel,
      get: runner.get,
      view: runner.view,
      tick: runner.tick,
      pending: runner.pending,
    };
  },
  // Una pasada cada dos segundos (la conciliación técnica, fila 6, reserva el segundo para los relojes de siempre);
  // cada pasada procesa hasta 1 000 filas o 800 ms, en trozos de 100 filas (cada uno, una transacción) y cede el hilo
  // entre trozos para que las peticiones y el tiempo real no esperen.
  timers: [{ name: 'trozos', everyMs: 2000, testEveryMs: 100, run: api => api.tick() }],
};
