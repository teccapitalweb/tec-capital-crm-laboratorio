// Cambio de número de WhatsApp (I-11, docs/PLAN_CAMBIO_DE_NUMERO.md; diseño de identidad y mudanza §7.5 a §7.8).
//
// Las tres herramientas para mudar el número real de la empresa al CRM sin un corte a ciegas:
//   - modo del número: activo o escucha, con su lista de prueba (lo que hace la escucha vive en server/lib/wa-listen.mjs
//     y en server/whatsapp.mjs, que no dependen de este módulo);
//   - abrir conversaciones recientes: al pasar a activo, una conversación EN ESPERA DE UNA PERSONA (asistente apagado)
//     para cada quien escribió en las últimas horas, sin duplicar y sin enviar nada;
//   - registrar el número en la cuenta de Meta con su PIN: el corte en sí.
//
// Rutas (con sesión; server/whatsapp.mjs las delega aquí). Todas piden channels.whatsapp.connect en la marca del número:
//   GET  /api/whatsapp/cutover                     números de las marcas de la persona, con contadores e historial
//   POST /api/whatsapp/numbers/:id/mode            {mode:'live'|'listen', listenAllow?:[teléfonos], expectedRevision, clientRef?}
//   POST /api/whatsapp/numbers/:id/open-recent     {hours?:1..24, preview?:true} → vista previa o {opened, existing, skipped}
//   POST /api/whatsapp/numbers/:id/register        {pin} → {ok}. El PIN viaja a Meta y no se guarda, no se registra,
//                                                  no se audita y no aparece en errores. 3 por hora por número.
// Tiempo real: 'wa_cutover.changed' {id} a quien ve la marca.
import { randomUUID } from 'node:crypto';
import { brandCourses } from '../../course-match.mjs';
import { MODES, normalizeAllow, parseAllow } from '../../lib/wa-listen.mjs';
import { createRepo } from './repo.mjs';

const PERM = 'channels.whatsapp.connect';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_HOURS = 24; // la ventana de servicio de Meta: más allá ya no se puede contestar sin plantilla
const MAX_OPEN = 500; // conversaciones por aplicación
const REF = /^[A-Za-z0-9_-]{1,80}$/;
const ROUTE = /^\/api\/whatsapp\/numbers\/(\d{1,30})\/(mode|open-recent|register)$/;
const NOTE =
  'Conversación abierta al pasar el número a activo: esta persona escribió en las últimas horas mientras el proveedor anterior atendía. El asistente está apagado; revisa el historial anterior y contesta tú.';

export default {
  name: 'wa-cutover',
  create(host) {
    const { db, fail, json, body, audit, rate, transaction } = host;
    const { whatsapp, connectors, crm, catalogue } = host.services;
    const repo = createRepo(db);
    const now = () => Date.now();
    const listen = whatsapp.listen;
    const replies = new Map(); // usuario:clientRef → resultado: un reintento no repite el cambio de modo

    const numberFor = (user, id) => {
      const n = repo.number(id);
      if (!n) throw fail(404, 'Número no encontrado.', { code: 'not_found' });
      host.access.require(user, PERM, n.brand_id);
      return n;
    };
    const emit = (brandId, id) => {
      try {
        host.realtime.emit('wa_cutover.changed', { brandId, data: { id } });
      } catch {}
    };

    function card(n, t = now()) {
      const mode = n.mode === 'listen' ? 'listen' : 'live';
      return {
        id: n.phone_number_id,
        label: n.label || n.phone_number_id,
        brandId: n.brand_id,
        brandName: repo.brandName(n.brand_id),
        enabled: Boolean(n.enabled),
        mode,
        listenAllow: parseAllow(n.listen_allow),
        revision: n.revision,
        modeChangedAt: n.mode_changed_at ?? null,
        // días completos en escucha (puerta de decisión: tres días sin pendientes)
        daysListening: mode === 'listen' && n.mode_changed_at ? Math.floor((t - n.mode_changed_at) / DAY) : 0,
        registeredAt: n.registered_at ?? null,
        rollbackRehearsedAt: repo.rollbackAt(n.brand_id, n.phone_number_id),
        openConversations: repo.openConversations(n.brand_id, n.phone_number_id),
        listen: listen.stats(n.phone_number_id, { days: 7, t }),
        history: repo.history(n.brand_id, n.phone_number_id).map(h => ({
          seq: h.seq,
          action: h.action,
          detail: h.detail,
          actor: h.actor_name || null,
          at: h.created_at,
        })),
      };
    }

    function changeMode(user, n, input) {
      const ref = input?.clientRef === undefined || input?.clientRef === null ? '' : String(input.clientRef);
      if (ref && !REF.test(ref)) throw fail(400, 'Referencia no válida.', { code: 'invalid_client_ref' });
      const key = user.id + ':' + n.phone_number_id + ':' + ref;
      if (ref && replies.has(key)) return replies.get(key);
      const mode = String(input?.mode ?? '');
      if (!MODES.includes(mode)) throw fail(400, 'El modo es «live» (activo) o «listen» (escucha).', { field: 'mode' });
      let allow = parseAllow(n.listen_allow);
      if (input?.listenAllow !== undefined) {
        const out = normalizeAllow(input.listenAllow);
        if (out.error) throw fail(400, out.error, { field: 'listenAllow' });
        allow = out.keys;
      }
      if (!Number.isInteger(input?.expectedRevision) || input.expectedRevision !== n.revision)
        throw fail(409, 'El número cambió. Recarga la pantalla.', { code: 'stale_record' });
      const t = now();
      const changed = mode !== (n.mode === 'listen' ? 'listen' : 'live');
      transaction(db, () => {
        if (!repo.setMode(n.brand_id, n.phone_number_id, mode, allow, t, user.id, n.revision).changes)
          throw fail(409, 'El número cambió. Recarga la pantalla.', { code: 'stale_record' });
        if (changed) repo.log(n.brand_id, n.phone_number_id, mode, '', user.id, t);
        audit(user, changed ? 'whatsapp.number.' + mode : 'whatsapp.number.listen_allow', n.phone_number_id);
      });
      emit(n.brand_id, n.phone_number_id);
      const result = { number: card(repo.number(n.phone_number_id)) };
      if (ref) {
        replies.set(key, result);
        if (replies.size > 500) replies.delete(replies.keys().next().value);
      }
      return result;
    }

    // Quiénes tendrían conversación nueva. Síncrono, sin escribir; dentro de la transacción de quien aplica.
    function plan(n, hours, t) {
      const list = repo.recent(n.brand_id, n.phone_number_id, t - hours * HOUR, MAX_OPEN);
      const out = { eligible: list.length, existing: 0, opened: 0, skipped: 0, items: [] };
      const p = whatsapp.pick(n);
      for (const r of list) {
        const marker = 'wa-recent:' + n.phone_number_id + ':' + r.user_id + ':' + (n.mode_changed_at ?? 0);
        if (repo.openWith(n.brand_id, n.phone_number_id, r.user_id) || repo.marked(marker)) out.existing++;
        else if (!p || repo.openInCourse(n.brand_id, r.user_id, p.courseId)) out.skipped++;
        else out.items.push({ userId: r.user_id, marker });
      }
      return { ...out, course: p };
    }

    function openRecent(user, n, input) {
      if (n.mode === 'listen')
        throw fail(409, 'El número sigue en escucha: pásalo a activo antes de abrir conversaciones.', {
          code: 'number_listen_only',
        });
      const hours = input?.hours === undefined ? MAX_HOURS : input.hours;
      if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS)
        throw fail(400, `Las horas van de 1 a ${MAX_HOURS}.`, { field: 'hours' });
      const t = now();
      if (input?.preview === true) {
        const p = transaction(db, () => plan(n, hours, t));
        return {
          preview: true,
          hours,
          eligible: p.eligible,
          existing: p.existing,
          skipped: p.skipped,
          toOpen: p.items.length,
        };
      }
      rate('wa-recent:' + user.id, 6);
      const multi = n.multi ? brandCourses(db, catalogue, n.brand_id).length > 1 : false;
      const done = transaction(db, () => {
        const p = plan(n, hours, t);
        const opened = [];
        for (const item of p.items) {
          const id = randomUUID(),
            peer = repo.peerPhone(item.userId);
          repo.insertConversation(n.brand_id, {
            id,
            userId: item.userId,
            courseId: p.course.courseId,
            editionId: p.course.editionId,
            numberId: n.phone_number_id,
            peer,
            pending: multi ? 1 : 0,
            t,
          });
          const c = repo.conversation(id);
          crm.syncConversation(c, { adoptContactId: whatsapp.identity.adoptable(n.brand_id, item.userId, peer) });
          host.insertMessage(c, null, NOTE, 'system', item.marker);
          opened.push(id);
        }
        repo.log(
          n.brand_id,
          n.phone_number_id,
          'open_recent',
          `${opened.length} de ${p.eligible} (${hours} h)`,
          user.id,
          t,
        );
        audit(user, 'whatsapp.number.open_recent', n.phone_number_id);
        return { opened, eligible: p.eligible, existing: p.existing, skipped: p.skipped };
      });
      for (const id of done.opened) host.broadcast('conversation', id);
      host.broadcast('crm', null, { brandId: n.brand_id });
      emit(n.brand_id, n.phone_number_id);
      return {
        hours,
        opened: done.opened.length,
        eligible: done.eligible,
        existing: done.existing,
        skipped: done.skipped,
      };
    }

    // El PIN se lee, se valida y se entrega a Meta; no pasa por la base, la bitácora, la auditoría ni un error.
    async function register(user, n, input) {
      rate('wa-register:' + n.phone_number_id, 3, HOUR);
      rate('wa-register-user:' + user.id, 5, HOUR);
      const pin = typeof input?.pin === 'string' ? input.pin : '';
      if (!/^\d{6}$/.test(pin))
        throw fail(400, 'El PIN de verificación en dos pasos son seis dígitos.', { field: 'pin' });
      const simulated = !connectors.metaLive();
      // la llamada a Meta, fuera de toda transacción; el simulado responde bien sin hacer nada
      if (!simulated) await connectors.adapters.channel.meta.register(n.phone_number_id, pin);
      const t = now();
      transaction(db, () => {
        repo.registered(n.brand_id, n.phone_number_id, t);
        repo.log(n.brand_id, n.phone_number_id, 'register', simulated ? 'simulado' : '', user.id, t);
        audit(user, 'whatsapp.number.registered', n.phone_number_id);
      });
      emit(n.brand_id, n.phone_number_id);
      return { ok: true, simulated, registeredAt: t };
    }

    const api = {
      async handle(req, res, path, user) {
        if (path === '/api/whatsapp/cutover' && req.method === 'GET') {
          host.access.require(user, PERM);
          const t = now();
          json(res, 200, {
            live: connectors.metaLive(),
            maxHours: MAX_HOURS,
            numbers: repo.numbersOf(host.access.brandIds(user, PERM)).map(n => card(n, t)),
          });
          return true;
        }
        const x = path.match(ROUTE);
        if (!x || req.method !== 'POST') return false;
        const n = numberFor(user, x[1]);
        const input = await body(req);
        if (x[2] === 'mode') json(res, 200, changeMode(user, n, input));
        else if (x[2] === 'open-recent') json(res, 200, openRecent(user, n, input));
        else json(res, 200, await register(user, n, input));
        return true;
      },
    };
    whatsapp.useCutover(api);
    return api;
  },
};
