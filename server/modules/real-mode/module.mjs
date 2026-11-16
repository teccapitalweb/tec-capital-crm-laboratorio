// Modo real por marca (docs/PLAN_MODO_REAL.md). Una marca que atiende clientes de verdad no les dice que es una prueba y
// no deja «pagar» con un método simulado. Apagado por omisión: sin encenderlo, la marca sigue en laboratorio como hoy.
//
// Rutas (con sesión):
//   GET   /api/real-mode                       estado de las marcas de la persona (equipo; sólo lectura) con lo que falta
//   PATCH /api/real-mode/brands/:id            {enabled?, paymentInstructions?, expectedRevision, confirm?, clientRef?}
//                                              settings.real_mode (administración). Cambiar el interruptor pide confirm:true.
//   POST  /api/real-mode/orders/:id/paid       {how, reference, note?, expectedRevision, clientRef?}
//                                              sales.payments.confirm en la marca del pedido; sólo pedidos de una marca real.
// Lo que cambia en los textos y en la página de pago vive en server/lib/real-mode.mjs y server/payments.mjs; aquí está el
// interruptor, el registro manual del pago y el paso de «Preparar marca». Tiempo real: 'real_mode.changed' {brandId}.
import { LAB_WORDING, realModeOf } from '../../lib/real-mode.mjs';
import { createRepo } from './repo.mjs';

const MANAGE = 'settings.real_mode';
const CONFIRM_PAID = 'sales.payments.confirm';
const REF = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_INSTRUCTIONS = 1500;
// Cómo pagó la persona cuando no hay pasarela: lo registra quien marca el pedido. El pedido guarda «transfer» (el único
// método manual que admite la tabla de pedidos) y el detalle real queda en la bitácora del pedido y en su nota.
const HOW = Object.freeze({
  transfer: 'Transferencia',
  deposit: 'Depósito bancario',
  cash: 'Efectivo en oficina',
  terminal: 'Terminal de la marca',
  other: 'Otro',
});

export default {
  name: 'real-mode',
  create(host) {
    const { db, fail, json, body, audit, broadcast, transaction } = host;
    const { crm, payments, readiness } = host.services;
    const repo = createRepo(db);
    const now = () => Date.now();
    const replies = new Map(); // usuario:clientRef → resultado: un reintento no repite el cambio ni el registro

    const emit = brandId => {
      try {
        host.realtime.emit('real_mode.changed', { brandId, data: { brandId } });
      } catch {}
    };
    const once = (user, input, run) => {
      const ref = input.clientRef;
      if (ref !== undefined && (typeof ref !== 'string' || !REF.test(ref)))
        throw fail(400, 'clientRef no válido.', { code: 'invalid_client_ref' });
      const key = ref ? user.id + ':' + ref : null;
      if (key && replies.has(key)) return replies.get(key);
      const out = run();
      if (key) {
        replies.set(key, out);
        if (replies.size > 500) replies.delete(replies.keys().next().value);
      }
      return out;
    };

    // Lo que conviene tener antes de encender (o lo que falta con el modo ya encendido). Sólo lee.
    function missing(brandId, state = realModeOf(db, brandId)) {
      const out = [];
      if (!repo.hasWhatsAppNumber(brandId)) out.push('WhatsApp real conectado (un número asignado a la marca)');
      if (!String(state.payment_instructions || '').trim()) out.push('instrucciones de pago');
      if (!repo.hasCurrentEdition(brandId, now())) out.push('una edición publicada con precio y fecha vigentes');
      const lab = repo.labTexts(brandId, LAB_WORDING);
      if (lab.length) out.push(lab.length + ' texto' + (lab.length === 1 ? '' : 's') + ' propios con aviso de prueba');
      return out;
    }
    function card(brandId) {
      const s = realModeOf(db, brandId),
        lab = repo.labTexts(brandId, LAB_WORDING);
      return {
        brandId,
        brandName: repo.brandName(brandId),
        enabled: s.enabled === 1,
        paymentInstructions: s.payment_instructions || '',
        revision: s.revision,
        updatedAt: s.updated_at || null,
        updatedByName: s.updated_by ? repo.userName(s.updated_by) : null,
        missing: missing(brandId, s),
        labTexts: lab.slice(0, 20),
      };
    }

    function setMode(user, brandId, input) {
      if (!repo.brandName(brandId)) throw fail(404, 'Marca no encontrada.', { code: 'not_found' });
      host.access.require(user, MANAGE, brandId);
      return once(user, input, () => {
        const current = realModeOf(db, brandId);
        if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.revision)
          throw fail(409, 'El modo real de esta marca cambió. Recarga la pantalla.', { code: 'stale_record' });
        const enabled = input.enabled === undefined ? current.enabled : input.enabled === true ? 1 : 0;
        if (input.enabled !== undefined && typeof input.enabled !== 'boolean')
          throw fail(400, 'Indica si el modo real queda encendido (true) o apagado (false).', { field: 'enabled' });
        let instructions = current.payment_instructions;
        if (input.paymentInstructions !== undefined) {
          if (typeof input.paymentInstructions !== 'string')
            throw fail(400, 'Las instrucciones de pago son un texto.', { field: 'paymentInstructions' });
          instructions = input.paymentInstructions.replace(/\r\n?/g, '\n').trim();
          if (instructions.length > MAX_INSTRUCTIONS)
            throw fail(400, 'Las instrucciones de pago admiten hasta ' + MAX_INSTRUCTIONS + ' caracteres.', {
              field: 'paymentInstructions',
            });
          if (LAB_WORDING.test(instructions))
            throw fail(400, 'Las instrucciones de pago no pueden decir que es una prueba o un ejemplo.', {
              field: 'paymentInstructions',
            });
        }
        if (enabled !== current.enabled && input.confirm !== true)
          throw fail(
            400,
            enabled
              ? 'Confirma que la marca atiende clientes reales: sus mensajes dejarán de decir que es una prueba y su página de pago ya no ofrecerá pagos simulados.'
              : 'Confirma que la marca vuelve al laboratorio: sus mensajes volverán a decir que es una prueba.',
            { code: 'confirm_required' },
          );
        if (enabled === current.enabled && instructions === current.payment_instructions) return card(brandId);
        const t = now();
        transaction(db, () => {
          if (!repo.save(brandId, { enabled, instructions, revision: current.revision, userId: user.id, at: t }))
            throw fail(409, 'El modo real de esta marca cambió. Recarga la pantalla.', { code: 'stale_record' });
        });
        if (enabled !== current.enabled) audit(user, enabled ? 'real_mode.on' : 'real_mode.off', brandId);
        if (instructions !== current.payment_instructions) audit(user, 'real_mode.instructions', brandId);
        broadcast('crm', null, { brandId });
        emit(brandId);
        return card(brandId);
      });
    }

    // Pago registrado por una persona del equipo (sin pasarela real): queda quién, cuándo, cómo y con qué referencia.
    function markPaid(user, orderId, input) {
      const o = repo.order(orderId);
      if (!o) throw fail(404, 'Pedido no disponible.', { code: 'not_found' });
      host.access.require(user, CONFIRM_PAID, o.brand_id);
      return once(user, input, () => {
        if (realModeOf(db, o.brand_id).enabled !== 1)
          throw fail(
            409,
            'Esta marca sigue en laboratorio: su pedido se confirma con un comprobante o con el pago de prueba.',
            {
              code: 'not_real_mode',
            },
          );
        if (!Object.hasOwn(HOW, input.how))
          throw fail(400, 'Indica cómo pagó la persona: transferencia, depósito, efectivo, terminal u otro.', {
            field: 'how',
          });
        const reference = typeof input.reference === 'string' ? input.reference.trim() : '';
        if (reference.length < 3 || reference.length > 80)
          throw fail(
            400,
            'Escribe la referencia del pago (de 3 a 80 caracteres): folio, número de operación o recibo.',
            {
              field: 'reference',
            },
          );
        const note = typeof input.note === 'string' ? input.note.trim().slice(0, 300) : '';
        if (!['pending', 'review'].includes(o.status))
          throw fail(409, 'Sólo se marca pagado un pedido pendiente o en revisión.', { code: 'invalid_state' });
        if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== o.revision)
          throw fail(409, 'El pedido cambió. Recárgalo antes de marcarlo pagado.', { code: 'stale_record' });
        const c = host.accessConversation(o.conversation_id, user);
        crm.requireBrand(user, c.brand_id);
        const t = now(),
          label = HOW[input.how] + ' · referencia ' + reference + (note ? ' · ' + note : '');
        const out = transaction(db, () => {
          const fresh = repo.order(o.id);
          if (fresh.revision !== o.revision || !['pending', 'review'].includes(fresh.status))
            throw fail(409, 'El pedido cambió. Recárgalo antes de marcarlo pagado.', { code: 'stale_record' });
          repo.closeReceipts(o.id, user.id, 'Pago registrado a mano: ' + label, t);
          repo.logPayment(
            o.id,
            { how: input.how, howLabel: HOW[input.how], reference, comment: note, note: label },
            user.id,
            t,
          );
          return payments.confirm(fresh, { actor: user, method: 'transfer', note: label });
        });
        audit(user, 'payment.order.mark_paid', o.id);
        broadcast('conversation', c.id);
        broadcast('crm', null, { brandId: c.brand_id });
        return payments.view(out);
      });
    }

    readiness.register({
      id: 'real-mode',
      group: 'Extras',
      title: 'Modo real: atiende clientes de verdad',
      required: false,
      view: 'operations',
      tab: 'payments',
      label: 'Ir a Pagos',
      check: brand => {
        const s = realModeOf(db, brand.id),
          left = missing(brand.id, s);
        if (s.enabled === 1)
          return left.length
            ? { done: false, detail: 'Encendido, pero falta: ' + left.join('; ') + '.' }
            : { done: true, detail: 'Encendido: sin avisos de prueba ni pagos simulados.' };
        return {
          done: false,
          detail: left.length
            ? 'Apagado (laboratorio). Antes de encenderlo falta: ' + left.join('; ') + '.'
            : 'Apagado (laboratorio). Ya tiene lo necesario para encenderlo.',
        };
      },
    });

    return {
      async handle(req, res, path, user) {
        if (path === '/api/real-mode' && req.method === 'GET') {
          host.requireStaff(user);
          json(res, 200, { brands: crm.brandsFor(user).map(b => card(b.id)) });
          return true;
        }
        let x = path.match(/^\/api\/real-mode\/brands\/([a-zA-Z0-9-]{1,60})$/);
        if (x && req.method === 'PATCH') {
          json(res, 200, { brand: setMode(user, x[1], await body(req)) });
          return true;
        }
        x = path.match(/^\/api\/real-mode\/orders\/([a-f0-9-]{36})\/paid$/);
        if (x && req.method === 'POST') {
          json(res, 200, { order: markPaid(user, x[1], await body(req)) });
          return true;
        }
        if (path.startsWith('/api/real-mode')) throw fail(405, 'Método no permitido.');
        return false;
      },
    };
  },
};
