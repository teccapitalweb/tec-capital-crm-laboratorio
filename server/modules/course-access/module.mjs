// Accesos del curso (docs/PLAN_CIERRE_DE_VENTA.md). Cierra la venta: cuando el pago de un pedido queda confirmado (una
// persona valida el comprobante o registra el pago, o lo confirma una pasarela real), el alumno recibe solo, en su
// conversación, el mensaje con los accesos de su apertura. Nace apagado: sin texto escrito y encendido por apertura no
// sale nada, igual que hoy. Este módulo NUNCA confirma un pago: sólo escucha `inscripcion.activada`, que publica
// server/payments.mjs dentro de la transacción de la confirmación.
//
// Rutas (con sesión):
//   GET  /api/course-access/brands                    las marcas de la persona (para elegir una)
//   GET  /api/course-access?brand=                     aperturas de la marca con su texto, inscritos y entregas recientes
//   PUT  /api/course-access/editions/:id               {enabled, onTestPayment, body, expectedRevision, clientRef?}
//                                                      sales.access.manage
//   POST /api/course-access/editions/:id/preview       {body} → el mensaje armado con los datos de la apertura y lo que falta
//   POST /api/course-access/editions/:id/send-pending  {clientRef} → envía a los inscritos que no lo han recibido (tope 100)
//   POST /api/course-access/enrollments/:id/send       {clientRef} → envío o reenvío de una persona (sales.charge)
//   GET  /api/course-access/conversations/:id          lo que el chat muestra de la venta: pedido, comprobante por revisar
//                                                      (se valida con las rutas de pagos) y estado de los accesos
// Tiempo real: 'course_access.changed' {brandId}.
import { randomUUID } from 'node:crypto';
import { fillTemplate, templateValues } from '../../catalogue.mjs';
import { isRealBrand } from '../../lib/real-mode.mjs';
import { startText } from '../../reply-copy.mjs';
import { createRepo } from './repo.mjs';

const MANAGE = 'sales.access.manage';
const SEND = 'sales.charge';
const REF = /^[A-Za-z0-9_:-]{1,120}$/;
const UUID = '([a-f0-9-]{36})';
const EDITION = '([a-zA-Z0-9_-]{1,80})';
const MAX_BODY = 2000;
const MIN_BODY = 20;
const BULK = 100;
const RECENT_MS = 30 * 24 * 3600 * 1000;

export const VARIABLES = Object.freeze([
  { key: 'nombre', label: 'Nombre de la persona' },
  { key: 'curso', label: 'Nombre del curso' },
  { key: 'edicion', label: 'Apertura' },
  { key: 'fecha', label: 'Fecha de inicio' },
  { key: 'docente', label: 'Docente' },
  { key: 'modalidad', label: 'Modalidad' },
  { key: 'grupo', label: 'Enlace del grupo (Coordinación)' },
  { key: 'pedido', label: 'Número de pedido' },
  { key: 'marca', label: 'Nombre de la marca' },
]);
const KEYS = VARIABLES.map(v => v.key);
// Marca de «falta llenar» del texto sugerido: mientras siga en el texto, la entrega no se puede encender.
const BLANK_MARK = /\(pega aqu[ií][^)]*\)/i;
export const SUGGESTION =
  '¡Te damos la bienvenida, {{nombre}}! Ya tienes tu lugar en {{curso}} · {{edicion}}.\n\n' +
  'Inicio: {{fecha}}\n\n' +
  'Tus accesos:\n' +
  '• Enlace de las clases: (pega aquí el enlace)\n' +
  '• Material del curso: (pega aquí el enlace)\n\n' +
  'Guarda este mensaje. Si algo no abre, escríbenos por aquí y te ayudamos.';

const REASONS = Object.freeze({
  off: 'La entrega automática está apagada en esta apertura.',
  empty: 'La apertura todavía no tiene accesos escritos.',
  test_payment: 'El pago fue de prueba (tarjeta u OXXO simulados) y esta apertura sólo entrega con pagos confirmados.',
  cancelled: 'La inscripción está cancelada.',
  failed: 'El mensaje no se pudo guardar en la conversación.',
});

// Lo que le falta a un texto para poder enviarse. Devuelve frases para la persona que lo escribe.
export function problemsOf(body, edition) {
  const out = [];
  const text = String(body || '');
  if (!text.trim()) return ['Escribe el mensaje con los accesos.'];
  if (text.trim().length < MIN_BODY) out.push('El mensaje es muy corto: escribe al menos ' + MIN_BODY + ' caracteres.');
  if (text.length > MAX_BODY) out.push('El mensaje admite hasta ' + MAX_BODY + ' caracteres.');
  const used = [...text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map(m => m[1]);
  const unknown = [...new Set(used.filter(k => !KEYS.includes(k)))];
  if (unknown.length) out.push('Hay datos que no existen: ' + unknown.map(k => '{{' + k + '}}').join(', ') + '.');
  if (/\{\{|\}\}/.test(text.replace(/\{\{\s*[^{}]*?\s*\}\}/g, ''))) out.push('Hay unas llaves {{ }} sin cerrar.');
  if (BLANK_MARK.test(text)) out.push('Todavía hay un «(pega aquí…)» sin llenar.');
  if (used.includes('grupo') && !String(edition?.group_url || '').trim())
    out.push('Usas {{grupo}}, pero esta apertura no tiene enlace de grupo (se pone en Coordinación).');
  return out;
}

export default {
  name: 'course-access',
  create(host) {
    const { db, fail, json, body, audit, broadcast, transaction } = host;
    const { crm, events, catalogue, payments, readiness } = host.services;
    const repo = createRepo(db);
    const now = () => Date.now();

    const emit = brandId => {
      try {
        host.realtime.emit('course_access.changed', { brandId, data: { brandId } });
      } catch {}
    };
    const clientRef = (input, required = false) => {
      const ref = input?.clientRef;
      if (ref === undefined && !required) return null;
      if (typeof ref !== 'string' || !REF.test(ref))
        throw fail(400, 'clientRef no válido.', { code: 'invalid_client_ref', field: 'clientRef' });
      return ref;
    };
    const stateOf = a => (!String(a.body || '').trim() ? 'empty' : a.enabled === 1 ? 'ready' : 'off');
    const firstName = name =>
      String(name || '')
        .trim()
        .split(/\s+/)[0] || '';

    // El mensaje armado con los datos vigentes de la apertura. Un dato sin valor no deja «undefined» ni un hueco raro.
    function render(text, edition, { name, reference }) {
      let values = {};
      try {
        values = templateValues(catalogue.info(edition.course_id, edition.id), firstName(name) || 'Hola');
      } catch {
        values = { nombre: firstName(name) || 'Hola', marca: repo.brandName(edition.brand_id) || '' };
      }
      return fillTemplate(text, {
        ...Object.fromEntries(KEYS.map(k => [k, values[k] ?? ''])),
        // la fecha, como la dice el asistente en el chat: «lunes, 23 de noviembre de 2026, 5:00 p.m. (hora del centro de
        // México)», no con el nombre técnico de la zona horaria
        fecha: startText(edition) ?? values.fecha ?? 'Por confirmar',
        grupo: String(edition.group_url || '').trim() || 'Por confirmar',
        pedido: reference || '',
      }).trim();
    }

    function card(row, brandId) {
      const a = { enabled: row.enabled ?? 0, on_test_payment: row.on_test_payment ?? 0, body: row.body ?? '' };
      return {
        editionId: row.id,
        courseId: row.course_id,
        courseTitle: row.course_title,
        editionName: row.name,
        startsAt: row.starts_at,
        timezone: row.timezone,
        status: row.status,
        hasGroup: Boolean(String(row.group_url || '').trim()),
        enrolled: row.enrolled ?? 0,
        delivered: row.delivered ?? 0,
        access: {
          state: stateOf(a),
          enabled: a.enabled === 1,
          onTestPayment: a.on_test_payment === 1,
          body: a.body,
          revision: row.revision ?? 0,
          updatedAt: row.updated_at ?? null,
          updatedByName: row.updated_by ? repo.userName(row.updated_by) : null,
          problems: a.body.trim() ? problemsOf(a.body, row) : [],
        },
        realMode: isRealBrand(db, brandId),
      };
    }
    const cardOf = (brandId, editionId) => {
      const row = repo.editions(brandId).find(e => e.id === editionId);
      if (row) return card(row, brandId);
      const e = repo.edition(brandId, editionId); // archivada o de un curso inactivo: se puede leer, no sale en la lista
      return card({ ...e, ...repo.access(editionId), id: e.id }, brandId);
    };
    const deliveryView = d => ({
      id: d.id,
      enrollmentId: d.enrollment_id,
      conversationId: d.conversation_id,
      editionId: d.edition_id,
      kind: d.kind,
      status: d.status,
      reason: d.reason || null,
      reasonLabel: d.status === 'skipped' ? REASONS[d.reason] || 'No se envió.' : null,
      at: d.created_at,
      contactName: d.contact_name,
      courseTitle: d.course_title,
      editionName: d.edition_name,
      sentByName: d.sent_by_name || null,
    });

    function overview(user, brandId) {
      host.requireStaff(user);
      if (!brandId || !repo.brandName(brandId)) throw fail(404, 'Marca no encontrada.', { code: 'not_found' });
      crm.requireBrand(user, brandId);
      return {
        brandId,
        brandName: repo.brandName(brandId),
        canManage: host.access.can(user, MANAGE, brandId),
        canSend: host.access.can(user, SEND, brandId),
        realMode: isRealBrand(db, brandId),
        variables: VARIABLES,
        suggestion: SUGGESTION,
        limits: { min: MIN_BODY, max: MAX_BODY },
        editions: repo.editions(brandId).map(r => card(r, brandId)),
        deliveries: repo.deliveries(brandId, 50).map(deliveryView),
      };
    }

    const editionFor = (user, editionId, permission) => {
      const found = repo.editionById(editionId);
      if (!found) throw fail(404, 'Apertura no disponible.', { code: 'not_found' });
      host.requireStaff(user);
      crm.requireBrand(user, found.brand_id);
      if (permission) host.access.require(user, permission, found.brand_id);
      return repo.edition(found.brand_id, editionId);
    };

    function save(user, editionId, input) {
      const e = editionFor(user, editionId, MANAGE);
      clientRef(input);
      const current = repo.access(e.id);
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.revision)
        throw fail(409, 'Los accesos de esta apertura cambiaron. Recarga la pantalla.', { code: 'stale_record' });
      for (const key of ['enabled', 'onTestPayment'])
        if (input[key] !== undefined && typeof input[key] !== 'boolean')
          throw fail(400, 'Indica sí o no (true o false).', { field: key });
      if (input.body !== undefined && typeof input.body !== 'string')
        throw fail(400, 'El mensaje de accesos es un texto.', { field: 'body' });
      const text = input.body === undefined ? current.body : input.body.replace(/\r\n?/g, '\n').trim();
      if (text.length > MAX_BODY)
        throw fail(400, 'El mensaje admite hasta ' + MAX_BODY + ' caracteres.', { field: 'body' });
      const enabled = input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0;
      const onTest = input.onTestPayment === undefined ? current.on_test_payment : input.onTestPayment ? 1 : 0;
      const problems = problemsOf(text, e);
      // Un borrador se guarda como esté; encendido, tiene que poder enviarse tal cual.
      if (enabled === 1 && problems.length)
        throw fail(400, 'Antes de encender la entrega: ' + problems[0], {
          code: 'not_ready',
          field: 'body',
          details: { problems },
        });
      const structural = problems.filter(p => /no existen|sin cerrar|hasta/.test(p));
      if (text && structural.length) throw fail(400, structural[0], { field: 'body', details: { problems } });
      if (enabled === current.enabled && onTest === current.on_test_payment && text === current.body)
        return cardOf(e.brand_id, e.id);
      const t = now();
      transaction(db, () => {
        if (
          !repo.save(e.brand_id, e.id, {
            enabled,
            onTestPayment: onTest,
            body: text,
            revision: current.revision,
            userId: user.id,
            at: t,
          })
        )
          throw fail(409, 'Los accesos de esta apertura cambiaron. Recarga la pantalla.', { code: 'stale_record' });
      });
      audit(
        user,
        enabled !== current.enabled ? (enabled ? 'course_access.on' : 'course_access.off') : 'course_access.edit',
        e.id,
      );
      broadcast('crm', null, { brandId: e.brand_id });
      emit(e.brand_id);
      return cardOf(e.brand_id, e.id);
    }

    function preview(user, editionId, input) {
      const e = editionFor(user, editionId, null);
      const text = typeof input.body === 'string' ? input.body.replace(/\r\n?/g, '\n').trim() : repo.access(e.id).body;
      if (text.length > MAX_BODY)
        throw fail(400, 'El mensaje admite hasta ' + MAX_BODY + ' caracteres.', { field: 'body' });
      return {
        text: text ? render(text, e, { name: 'Ana', reference: 'TC-EJEMPLO' }) : '',
        problems: problemsOf(text, e),
      };
    }

    // Por qué la entrega automática no saldría para un pedido confirmado ('' = sí sale). Lo usan la entrega y la frase de
    // la confirmación del pago. `o` trae brand_id y confirmed_by (un pedido, o la inscripción con los datos de su pedido).
    function autoSkip(a, o) {
      if (!String(a.body || '').trim()) return 'empty';
      if (a.enabled !== 1) return 'off';
      // marca en laboratorio y nadie del equipo confirmó: fue un pago simulado
      if (!o.confirmed_by && !isRealBrand(db, o.brand_id) && a.on_test_payment !== 1) return 'test_payment';
      return '';
    }

    // Una entrega. `auto` es la del pago confirmado (una por inscripción, pase lo que pase); `manual` la pide una persona.
    // Devuelve la fila de la entrega; con `auto`, si ya existía devuelve la que había.
    function deliver(enrollmentId, { kind, user = null, ref = null }) {
      const n = repo.enrollment(enrollmentId);
      if (!n) return null;
      const c = repo.conversation(n.conversation_id),
        e = repo.edition(n.brand_id, n.edition_id),
        a = repo.access(n.edition_id);
      if (!c || !e) return null;
      let skip = '';
      if (n.status !== 'enrolled') skip = 'cancelled';
      else if (!a.body.trim()) skip = 'empty';
      else if (kind === 'auto') skip = autoSkip(a, n);
      if (kind === 'manual' && skip)
        throw fail(409, REASONS[skip], { code: skip === 'cancelled' ? 'invalid_state' : 'not_ready' });
      const text = skip ? '' : render(a.body, e, { name: n.contact_name, reference: n.reference });
      const id = randomUUID(),
        t = now();
      const out = transaction(db, () => {
        const before = kind === 'auto' ? repo.autoDelivery(n.id) : ref ? repo.byRef(ref) : null;
        if (before) return { row: before, fresh: false };
        let messageId = null,
          reason = skip;
        if (!skip) {
          db.exec('SAVEPOINT course_access_message');
          try {
            messageId = host.insertMessage(c, null, text, 'automation', 'course-access:' + id, null, null, null, {
              category: 'utility',
            });
            db.exec('RELEASE course_access_message');
          } catch (error) {
            db.exec('ROLLBACK TO course_access_message');
            db.exec('RELEASE course_access_message');
            if (kind === 'manual') throw error;
            reason = 'failed'; // la entrega automática deja constancia y una persona puede reenviar desde el chat
          }
        }
        repo.insertDelivery({
          id,
          brandId: n.brand_id,
          editionId: n.edition_id,
          enrollmentId: n.id,
          conversationId: c.id,
          kind,
          status: reason ? 'skipped' : 'sent',
          reason,
          messageId,
          accessRevision: a.revision,
          sentBy: user?.id || null,
          clientRef: ref,
          at: t,
        });
        return { row: repo.delivery(id), fresh: true };
      });
      if (out.fresh) {
        if (user) audit(user, 'course_access.send', n.id);
        if (out.row.status === 'sent') broadcast('conversation', c.id);
        broadcast('crm', null, { brandId: n.brand_id });
        emit(n.brand_id);
      }
      return out.row;
    }

    function sendOne(user, enrollmentId, input) {
      const n = repo.enrollment(enrollmentId);
      if (!n) throw fail(404, 'Inscripción no disponible.', { code: 'not_found' });
      host.requireStaff(user);
      const c = host.accessConversation(n.conversation_id, user);
      crm.requireBrand(user, c.brand_id);
      host.access.require(user, SEND, n.brand_id);
      const row = deliver(n.id, { kind: 'manual', user, ref: clientRef(input, true) });
      return { delivery: { id: row.id, status: row.status, at: row.created_at }, sale: saleOf(user, c.id) };
    }

    function sendPending(user, editionId, input) {
      const e = editionFor(user, editionId, MANAGE);
      const ref = clientRef(input, true);
      const a = repo.access(e.id);
      const problems = problemsOf(a.body, e);
      if (problems.length) throw fail(409, 'Antes de enviar: ' + problems[0], { code: 'not_ready' });
      let sent = 0;
      for (const id of repo.pending(e.brand_id, e.id, BULK)) {
        try {
          if (deliver(id, { kind: 'manual', user, ref: ref + ':' + id })?.status === 'sent') sent++;
        } catch (error) {
          if (!error?.status) throw error; // una inscripción que no admite envío no detiene a las demás
        }
      }
      return { sent, left: repo.pending(e.brand_id, e.id, BULK + 1).length, edition: cardOf(e.brand_id, e.id) };
    }

    // Lo que el chat del equipo muestra sobre la venta de una conversación. Sólo lee.
    function saleOf(user, conversationId) {
      host.requireStaff(user);
      const c = host.accessConversation(conversationId, user);
      crm.requireBrand(user, c.brand_id);
      const o = repo.latestOrder(c.id);
      if (!o) return { order: null, receipt: null, enrollment: null, access: null };
      const v = payments.view(o),
        r = o.status === 'review' ? repo.pendingReceipt(o.id) : null,
        n = o.status === 'paid' ? repo.enrollmentOfOrder(o.id) : null,
        a = repo.access(o.edition_id),
        last = n ? repo.lastDelivery(n.id) : null;
      return {
        order: {
          id: o.id,
          reference: o.reference,
          status: o.status,
          statusLabel: v.statusLabel,
          amountLabel: v.amountLabel,
          courseTitle: v.courseTitle,
          editionName: v.editionName,
          editionId: o.edition_id,
          revision: o.revision,
          realMode: v.realMode,
          paidAt: o.paid_at,
          recent: o.status !== 'paid' || (o.paid_at || 0) > now() - RECENT_MS,
        },
        receipt: r
          ? { id: r.id, filename: r.filename, mime: r.mime, url: '/api/files/' + r.attachment_id, at: r.created_at }
          : null,
        enrollment: n ? { id: n.id, status: n.status, at: n.created_at } : null,
        access: {
          state: stateOf(a),
          sent: n ? repo.wasSent(n.id) : false,
          last: last
            ? {
                kind: last.kind,
                status: last.status,
                reason: last.reason || null,
                reasonLabel: last.status === 'skipped' ? REASONS[last.reason] || 'No se envió.' : null,
                at: last.created_at,
              }
            : null,
          canSend: Boolean(n && n.status === 'enrolled' && a.body.trim() && host.access.can(user, SEND, c.brand_id)),
          canManage: host.access.can(user, MANAGE, c.brand_id),
        },
      };
    }

    // La confirmación del pago dice «enseguida te mando tus accesos» sólo si de verdad van a salir solos.
    payments.useAccessHint?.(o => o.kind !== 'session' && autoSkip(repo.access(o.edition_id), o) === '');

    // El asistente (server/replies.mjs) reenvía los accesos a quien los pide por el chat («¿dónde entro?», «no me llegó el
    // enlace») sólo si ya está inscrito y los accesos de su apertura se pueden enviar tal cual: los mismos que ya recibió o
    // los que saldrían solos al confirmar. Si no, responde null o el motivo y la conversación pasa a una persona. Sólo lee;
    // `record` deja la entrega anotada como un reenvío (sin persona) en la transacción del asistente.
    host.services.replies?.useAccess?.({
      forConversation(c) {
        const o = repo.latestOrder(c.id);
        if (!o || o.status !== 'paid' || o.brand_id !== c.brand_id) return null;
        const n0 = repo.enrollmentOfOrder(o.id);
        if (!n0 || n0.status !== 'enrolled') return null;
        const n = repo.enrollment(n0.id),
          e = repo.edition(n.brand_id, n.edition_id),
          a = repo.access(n.edition_id);
        const reason = !e ? 'empty' : problemsOf(a.body, e).length ? 'empty' : repo.wasSent(n.id) ? '' : autoSkip(a, n);
        if (reason) return { enrolled: true, ready: false, reason };
        return {
          enrolled: true,
          ready: true,
          enrollmentId: n.id,
          text: render(a.body, e, { name: n.contact_name, reference: n.reference }),
        };
      },
      record(enrollmentId, messageId) {
        const n = repo.enrollment(enrollmentId);
        if (!n || !messageId) return;
        repo.insertDelivery({
          id: randomUUID(),
          brandId: n.brand_id,
          editionId: n.edition_id,
          enrollmentId: n.id,
          conversationId: n.conversation_id,
          kind: 'manual',
          status: 'sent',
          reason: '',
          messageId,
          accessRevision: repo.access(n.edition_id).revision,
          sentBy: null,
          clientRef: 'assistant:' + messageId,
          at: now(),
        });
        emit(n.brand_id);
      },
    });

    // El pago confirmado inscribe (server/payments.mjs) y publica `inscripcion.activada`; aquí sale el mensaje de accesos.
    events.subscribe('inscripcion.activada', 'course-access.deliver', ev => {
      deliver(ev.entity_id, { kind: 'auto' });
    });

    readiness.register({
      id: 'course-access',
      group: 'Extras',
      title: 'Accesos del curso: lo que recibe quien paga',
      required: false,
      view: 'accesos',
      label: 'Ir a Accesos',
      check: brand => {
        const t = now(),
          total = repo.publishedCount(brand.id, t),
          left = repo.openWithoutAccess(brand.id, t);
        if (!total) return { done: false, detail: 'No hay aperturas publicadas por empezar.' };
        if (!left.length)
          return { done: true, detail: 'Cada apertura por empezar entrega sus accesos al confirmar el pago.' };
        return {
          done: false,
          detail:
            (left.length === 1 ? 'Falta 1 apertura' : 'Faltan ' + left.length + ' aperturas') +
            ' por entregar accesos: ' +
            [...new Set(left)].slice(0, 5).join(', ') +
            '. Quien pague recibirá sólo la confirmación.',
        };
      },
    });

    return {
      deliver,
      saleOf,
      async handle(req, res, path, user, url) {
        if (path === '/api/course-access/brands' && req.method === 'GET') {
          host.requireStaff(user); // las marcas de la persona, para elegir una cuando la barra lateral dice «todas»
          json(res, 200, { brands: crm.brandsFor(user).map(b => ({ id: b.id, name: b.name })) });
          return true;
        }
        if (path === '/api/course-access' && req.method === 'GET') {
          json(res, 200, overview(user, url.searchParams.get('brand')));
          return true;
        }
        let x = path.match(new RegExp('^/api/course-access/editions/' + EDITION + '$'));
        if (x && req.method === 'PUT') {
          json(res, 200, { edition: save(user, x[1], await body(req)) });
          return true;
        }
        x = path.match(new RegExp('^/api/course-access/editions/' + EDITION + '/(preview|send-pending)$'));
        if (x && req.method === 'POST') {
          const input = await body(req);
          json(res, 200, x[2] === 'preview' ? preview(user, x[1], input) : sendPending(user, x[1], input));
          return true;
        }
        x = path.match(new RegExp('^/api/course-access/enrollments/' + UUID + '/send$'));
        if (x && req.method === 'POST') {
          json(res, 200, sendOne(user, x[1], await body(req)));
          return true;
        }
        x = path.match(new RegExp('^/api/course-access/conversations/' + UUID + '$'));
        if (x && req.method === 'GET') {
          json(res, 200, saleOf(user, x[1]));
          return true;
        }
        if (path.startsWith('/api/course-access')) throw fail(405, 'Método no permitido.');
        return false;
      },
    };
  },
};
