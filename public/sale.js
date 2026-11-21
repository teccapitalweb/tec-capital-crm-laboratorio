// Cierre de la venta en el chat (docs/PLAN_CIERRE_DE_VENTA.md): una franja sobre el compositor que aparece sólo cuando hay
// algo que hacer o que saber. Con un comprobante por revisar: verlo, validar el pago o avisar que no es válido. Con el
// pago ya confirmado: si los accesos del curso salieron, y el botón para enviarlos o reenviarlos. Sólo para el equipo.
// Validar usa las rutas de pagos de siempre; aquí no se confirma nada por cuenta propia. Acciones con el prefijo «sale-».
window.createSaleUI = function ({ api, esc, icon, toast, setView }) {
  const $ = s => document.querySelector(s);
  const cache = new Map(); // conversationId -> lo que respondió /api/course-access/conversations/:id
  let rejecting = null; // conversationId con el motivo abierto
  let busy = false;
  const when = t =>
    new Date(t).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const button = (action, label, primary = false) =>
    `<button type="button" class="btn${primary ? ' primary' : ''}" data-action="${action}" ${busy ? 'disabled' : ''}>${esc(label)}</button>`;

  // Nombre que la persona pidió por el chat para su constancia (docs/PLAN_RESPUESTAS_DE_VENTA.md): se confirma en Certificados.
  const certName = d =>
    d.certificateName?.name
      ? `<small>Nombre que pidió para su constancia: ${esc(d.certificateName.name)} · ${d.certificateName.status === 'confirmed' ? 'confirmado' : 'por confirmar en Certificados'}</small>`
      : '';
  function review(d) {
    const o = d.order,
      r = d.receipt;
    const access =
      d.access?.state === 'ready'
        ? 'Al validar, recibe su confirmación y sus accesos.'
        : 'Al validar, recibe su confirmación. Este curso todavía no envía accesos solo.';
    return `<div class="sale-strip sale-review" role="group" aria-label="Comprobante por revisar">
      <div class="sale-what">${icon('receipt')}<span><b>Comprobante por revisar</b><small>${esc(o.reference)} · ${esc(o.amountLabel)} · ${esc(o.courseTitle)}</small><small>${esc(access)}</small>${certName(d)}</span></div>
      <div class="sale-actions"><a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">Ver comprobante</a>${button('sale-accept', 'Validar pago', true)}${button('sale-reject', 'No es válido')}</div>
      ${
        rejecting === d.id
          ? `<div class="sale-reason"><label for="sale-reason">¿Por qué no es válido? La persona recibe este motivo.</label><input id="sale-reason" type="text" maxlength="300" autocomplete="off" placeholder="Ej.: el importe no coincide con el pedido"><span>${button('sale-reject-send', 'Avisar a la persona', true)}${button('sale-reject-close', 'Cancelar')}</span></div>`
          : ''
      }
    </div>`;
  }
  function paid(d) {
    const a = d.access || {},
      o = d.order;
    let title = 'Pago confirmado · accesos enviados',
      detail = a.last ? when(a.last.at) : '',
      action = a.canSend ? button('sale-send', 'Reenviar accesos') : '',
      tone = 'sale-done';
    if (!a.sent && a.state === 'empty') {
      title = 'Pago confirmado · este curso todavía no tiene accesos escritos';
      detail = a.canManage
        ? 'Escríbelos y vuelve aquí para enviarlos.'
        : 'Pide a administración que los escriba en Accesos.';
      action = a.canManage ? button('sale-config', 'Escribir accesos', true) : '';
      tone = 'sale-missing';
    } else if (!a.sent) {
      title = 'Pago confirmado · accesos sin enviar';
      detail = a.last?.reasonLabel || 'Todavía no se le han enviado.';
      action = a.canSend ? button('sale-send', 'Enviar accesos', true) : '';
      tone = 'sale-missing';
    }
    return `<div class="sale-strip ${tone}" role="group" aria-label="Accesos del curso">
      <div class="sale-what">${icon(a.sent ? 'key-round' : 'triangle-alert')}<span><b>${esc(title)}</b><small>${esc(o.reference)} · ${esc(o.courseTitle)}${detail ? ' · ' + esc(detail) : ''}</small>${certName(d)}</span></div>
      <div class="sale-actions">${action}</div>
    </div>`;
  }
  function paint(id) {
    const box = $('#conv-sale');
    if (!box || box.dataset.id !== id) return;
    const d = cache.get(id);
    let out = '';
    if (d?.order?.status === 'review' && d.receipt) out = review({ ...d, id });
    else if (d?.order?.status === 'paid' && d.order.recent && d.enrollment?.status === 'enrolled') out = paid(d);
    if (box.innerHTML === '' && out === '') return;
    const reason = $('#sale-reason')?.value;
    box.innerHTML = out;
    if (reason !== undefined && $('#sale-reason')) $('#sale-reason').value = reason;
    window.lucide?.createIcons({ attrs: { 'stroke-width': 1.7 } });
  }
  async function load(id) {
    try {
      cache.set(id, await api('/api/course-access/conversations/' + id));
    } catch {
      if (!cache.has(id)) cache.set(id, null);
    }
    paint(id);
  }
  function mount(c) {
    const box = $('#conv-sale');
    if (!box) return;
    box.dataset.id = c.id;
    if (rejecting && rejecting !== c.id) rejecting = null;
    if (cache.has(c.id)) paint(c.id);
    load(c.id);
  }
  async function run(id, work) {
    if (busy) return;
    busy = true;
    paint(id);
    try {
      await work();
    } catch (e) {
      toast(e.message || 'No se pudo completar.');
    } finally {
      busy = false;
      await load(id);
    }
  }
  async function action(name) {
    const id = $('#conv-sale')?.dataset.id,
      d = id ? cache.get(id) : null;
    if (!d?.order) return;
    if (name === 'sale-reject') {
      rejecting = id;
      paint(id);
      $('#sale-reason')?.focus();
      return;
    }
    if (name === 'sale-reject-close') {
      rejecting = null;
      paint(id);
      return;
    }
    if (name === 'sale-config') {
      setView('accesos');
      return;
    }
    if (name === 'sale-accept' && d.receipt) {
      if (
        !confirm(
          '¿Validar el pago del pedido ' +
            d.order.reference +
            ' por ' +
            d.order.amountLabel +
            '? Se inscribe a la persona y se le avisa por el chat.',
        )
      )
        return;
      await run(id, async () => {
        await api('/api/payments/receipts/' + d.receipt.id + '/accept', { method: 'POST', body: { note: '' } });
        toast(
          d.access?.state === 'ready' ? 'Pago validado: ya recibe sus accesos.' : 'Pago validado e inscripción hecha.',
        );
      });
      return;
    }
    if (name === 'sale-reject-send' && d.receipt) {
      const reason = ($('#sale-reason')?.value || '').trim();
      if (reason.length < 5) {
        toast('Escribe el motivo (mínimo 5 letras): la persona lo recibe.');
        $('#sale-reason')?.focus();
        return;
      }
      await run(id, async () => {
        await api('/api/payments/receipts/' + d.receipt.id + '/reject', { method: 'POST', body: { reason } });
        rejecting = null;
        toast('Se le avisó que el comprobante no es válido.');
      });
      return;
    }
    if (name === 'sale-send' && d.enrollment) {
      if (d.access?.sent && !confirm('¿Reenviar los accesos a esta persona? Los recibirá otra vez en este chat.'))
        return;
      await run(id, async () => {
        await api('/api/course-access/enrollments/' + d.enrollment.id + '/send', {
          method: 'POST',
          body: { clientRef: crypto.randomUUID() },
        });
        toast('Accesos enviados.');
      });
    }
  }
  return { mount, action };
};
