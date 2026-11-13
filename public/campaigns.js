// Campañas y envíos segmentados (pestaña de Operación, administración). Una campaña = plantilla aprobada + segmento + fecha.
// Todo se calcula en el servidor (docs/PLAN_CAMPANAS.md): aquí sólo se arma, se revisa con vista previa y se programa.
window.createCampaignsUI = function ({ state, api, esc, icon, showModal, toast }) {
  const $ = s => document.querySelector(s);
  const stamp = t =>
    t ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(t) : '—';
  const brandName = id => state.brands.find(b => b.id === id)?.name || '';
  const STATUS = {
    draft: ['Borrador', ''],
    scheduled: ['Programada', 'high'],
    sending: ['Enviando', 'good'],
    completed: ['Completada', 'ok'],
    cancelled: ['Cancelada', 'warn'],
  };
  const STATE = {
    queued: ['En cola', ''],
    sent: ['Enviado', 'ok'],
    skipped: ['Omitido', 'warn'],
    failed: ['Fallido', 'urgent'],
  };
  const DELIVERY = { sent: 'Enviado', delivered: 'Entregado', read: 'Leído', failed: 'Falló' };
  const STAGES = {
    nuevo: 'Nuevo interés',
    interesado: 'Interesado',
    inscripcion: 'Inscripción solicitada',
    ganada: 'Ganada',
    perdida: 'Perdida',
  };
  const CHANNELS = { whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook' };
  const chip = (label, kind = '') => `<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const btn = (action, label, id = '', extra = '', klass = '') =>
    `<button type="button" class="btn ${klass}" data-action="cmp-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const note = copy => `<p class="crm-hint">${copy}</p>`;
  const brandId = () => (state.brand === 'all' ? '' : state.brand);
  let list = [],
    settings = [],
    templates = [],
    tags = [],
    preview = null,
    previewFor = null,
    openId = null;

  async function load() {
    const [c, s, cat, t] = await Promise.all([
      api('/api/campaigns' + (brandId() ? '?brand=' + encodeURIComponent(brandId()) : '')),
      api('/api/campaigns/settings'),
      api('/api/catalogue'),
      api('/api/crm/tags'),
    ]);
    list = c.campaigns;
    settings = s.settings;
    templates = cat.templates.filter(x => x.status === 'approved');
    tags = t.tags;
  }
  function segmentText(c) {
    const s = c.segment,
      out = [];
    if (s.stages) out.push('etapa: ' + s.stages.map(x => STAGES[x] || x).join(', '));
    if (s.courseId) out.push('curso: ' + (state.courses.find(k => k.id === s.courseId)?.title || ''));
    if (s.channel) out.push('canal: ' + (CHANNELS[s.channel] || s.channel));
    if (s.tagIds)
      out.push(
        'etiquetas: ' +
          s.tagIds
            .map(id => tags.find(t => t.id === id)?.name || '')
            .filter(Boolean)
            .join(', '),
      );
    if (s.inactiveDays) out.push('sin responder hace ' + s.inactiveDays + ' días o más');
    return (
      (out.length ? out.join(' · ') : 'todos los contactos con conversación') +
      (c.requireConsent ? ' · con consentimiento registrado' : ' · sin baja registrada')
    );
  }
  const funnel = s =>
    `<div class="ops-stats co-stats">${[
      ['Destinatarios', s.recipients],
      ['Enviados', s.sent],
      ['Entregados', s.delivered],
      ['Leídos', s.read],
      ['Respondieron', s.replied],
      ['Bajas', s.optedOut],
      ['En cola', s.queued],
      ['Omitidos', s.skipped + s.stepFailed + s.deliveryFailed],
    ]
      .map(([l, v]) => `<div class="ops-stat"><strong>${v}</strong><span>${l}</span></div>`)
      .join('')}</div>`;

  function settingsPanel() {
    const rows = brandId() ? settings.filter(s => s.brand_id === brandId()) : settings;
    return `<section class="crm-panel cmp-settings"><div class="ops-card-top"><h2>Campañas por marca</h2></div>${note('Todo empieza apagado. Una campaña sólo se envía si las campañas <strong>y</strong> la automatización de la marca están encendidas (esta última se activa en Seguimientos); la pausa global las detiene sin perder nada.')}
      <div class="cmp-brands">${rows.map(s => `<div class="rcp-brand"><div><strong>${esc(s.brand_name)}</strong><small>${s.enabled ? 'Encendidas' : 'Apagadas'} · ${s.automationEnabled ? 'automatización encendida' : 'automatización apagada'}<br>Separación ${s.min_gap_hours} h · ${s.pace_seconds} s entre envíos · máx. ${s.max_audience}</small></div><div class="actions">${btn('toggle', s.enabled ? 'Apagar' : 'Encender', s.brand_id, `data-revision="${s.revision}"`)}${btn('settings', 'Ajustes', s.brand_id)}</div></div>`).join('')}</div></section>`;
  }
  function card(c) {
    const [label, kind] = STATUS[c.status],
      s = c.stats;
    return `<article class="crm-panel rcp-card cmp-card"><div class="ops-card-top"><strong>${esc(c.title)}</strong>${chip(label, kind)}</div><small>${esc(c.brandName)} · ${esc(c.templateTitle)}</small><p>${esc(segmentText(c))}.</p>
      <div class="cmp-mini"><span><strong>${s.recipients || c.audienceConfirmed || 0}</strong> destinatarios</span><span><strong>${s.sent}</strong> enviados</span><span><strong>${s.replied}</strong> respondieron</span></div>
      <small>${c.status === 'scheduled' ? 'Sale el ' + stamp(c.scheduledAt) : c.finishedAt ? 'Terminó el ' + stamp(c.finishedAt) : c.startedAt ? 'Empezó el ' + stamp(c.startedAt) : 'Creada el ' + stamp(c.createdAt)}</small>
      <div class="actions">${btn('detail', 'Ver', c.id)}${c.status === 'draft' ? btn('edit', 'Editar', c.id) : ''}${['draft', 'scheduled', 'sending'].includes(c.status) ? btn('cancel', 'Cancelar', c.id, `data-revision="${c.revision}"`) : ''}</div></article>`;
  }
  function html() {
    if (!list && !settings.length) return '<div class="loading-message">Cargando…</div>';
    return `${settingsPanel()}<div class="crm-toolbar"><p>Envía una plantilla aprobada a un segmento, ahora o programada. Revisa siempre la vista previa: muestra a quién excluye y por qué.</p>${btn('new', icon('plus') + ' Nueva campaña', '', '', 'primary')}</div><div class="rcp-grid">${list.length ? list.map(card).join('') : '<div class="crm-empty"><h2>Sin campañas todavía</h2><p>Crea la primera: elige una plantilla aprobada y el público al que va dirigida.</p></div>'}</div>${note('Los envíos son del canal simulado: el costo es una estimación con tarifas de marketing y no se cobra nada. No se interrumpe a quien atiende una persona del equipo ni se escribe a quien pidió la baja.')}`;
  }

  // ---- editor
  function editor(c, forBrand, carry = {}) {
    const b = c?.brandId || forBrand || brandId() || state.brands[0]?.id,
      seg = c?.segment || carry.segment || {},
      tpls = templates.filter(t => t.brand_id === b && !t.edition_id),
      courses = state.courses.filter(k => k.brand_id === b),
      brandTags = tags.filter(t => t.brand_id === b);
    showModal(
      c ? 'Editar campaña' : 'Nueva campaña',
      `<form id="cmp-form" class="form-grid rcp-form"><input type="hidden" name="id" value="${esc(c?.id || '')}"><input type="hidden" name="expectedRevision" value="${c?.revision || ''}">
      ${c ? `<p class="crm-hint">${esc(brandName(b))}</p><input type="hidden" name="brandId" value="${esc(b)}">` : `<label class="field">Marca<select name="brandId" id="cmp-brand">${state.brands.map(x => `<option value="${esc(x.id)}" ${x.id === b ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`}
      <label class="field">Nombre<input name="title" required maxlength="120" value="${esc(c?.title || carry.title || '')}" placeholder="Reactivar interesados de noviembre"></label>
      <label class="field">Plantilla aprobada<select name="templateId" required>${tpls.map(t => `<option value="${esc(t.id)}" ${(c?.templateId || carry.templateId) === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('') || '<option value="">Sin plantillas aprobadas</option>'}</select></label>
      <fieldset class="rcp-fieldset"><legend>Público</legend>
        <div class="rcp-checks">${Object.entries(STAGES)
          .map(
            ([k, l]) =>
              `<label><input type="checkbox" name="stage" value="${k}" ${seg.stages?.includes(k) ? 'checked' : ''}> ${l}</label>`,
          )
          .join('')}</div>
        <label class="field">Curso<select name="courseId"><option value="">Cualquier curso</option>${courses.map(k => `<option value="${esc(k.id)}" ${seg.courseId === k.id ? 'selected' : ''}>${esc(k.title)}</option>`).join('')}</select></label>
        <label class="field">Canal<select name="channel"><option value="">Cualquier canal</option>${Object.entries(
          CHANNELS,
        )
          .map(([k, l]) => `<option value="${k}" ${seg.channel === k ? 'selected' : ''}>${l}</option>`)
          .join('')}</select></label>
        ${brandTags.length ? `<div class="rcp-checks">${brandTags.map(t => `<label><input type="checkbox" name="tag" value="${esc(t.id)}" ${seg.tagIds?.includes(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}</div>` : ''}
        <label class="field">Días sin responder (opcional)<input name="inactiveDays" type="number" min="1" max="365" value="${seg.inactiveDays || ''}" placeholder="Por ejemplo 14"></label>
        <label class="rcp-consent"><input type="checkbox" name="requireConsent" ${(c ? c.requireConsent : (carry.requireConsent ?? true)) ? 'checked' : ''}> Enviar sólo a contactos con consentimiento registrado</label>
      </fieldset>
      ${note('Sin ningún criterio marcado la campaña va a todos los contactos de la marca con una conversación abierta. Quien pidió la baja nunca recibe mensajes.')}
      <div class="actions"><button class="btn primary" type="submit">${c ? 'Guardar cambios' : 'Guardar borrador'}</button></div><div class="ops-feedback" role="status"></div></form>`,
    );
  }
  function body(form) {
    const f = new FormData(form),
      seg = {},
      stages = f.getAll('stage'),
      tagIds = f.getAll('tag'),
      days = Number(f.get('inactiveDays'));
    if (stages.length) seg.stages = stages;
    if (f.get('courseId')) seg.courseId = f.get('courseId');
    if (f.get('channel')) seg.channel = f.get('channel');
    if (tagIds.length) seg.tagIds = tagIds;
    if (days) seg.inactiveDays = days;
    return {
      brandId: f.get('brandId'),
      title: f.get('title'),
      templateId: f.get('templateId'),
      segment: seg,
      requireConsent: f.get('requireConsent') === 'on',
    };
  }

  // ---- detalle, vista previa y programación
  async function detail(id) {
    openId = id;
    const [{ campaign: c }, { events }, rec] = await Promise.all([
      api('/api/campaigns/' + id),
      api('/api/campaigns/' + id + '/events'),
      api('/api/campaigns/' + id + '/recipients?limit=100'),
    ]);
    const [label, kind] = STATUS[c.status],
      canSchedule = c.status === 'draft',
      p = previewFor === id ? preview : null;
    const KIND = {
      created: 'Creada',
      updated: 'Editada',
      scheduled: 'Programada',
      launched: 'Empezó el envío',
      queued: 'Destinatarios en cola',
      completed: 'Completada',
      cancelled: 'Cancelada',
    };
    showModal(
      c.title,
      `<div class="cmp-detail"><div class="ops-card-top">${chip(label, kind)}<small>${esc(c.brandName)} · ${esc(c.templateTitle)}</small></div><p class="crm-hint">${esc(segmentText(c))}.</p>
      ${c.status === 'draft' || c.status === 'scheduled' ? `<section class="cmp-block"><div class="ops-card-top"><h3>Vista previa del público</h3>${btn('preview', icon('search') + ' Calcular', c.id)}</div>${p ? previewBox(p) : note('Calcula la vista previa para ver a cuántas personas llegaría, a quiénes excluye y cómo se ve el mensaje.')}</section>` : ''}
      ${
        canSchedule
          ? `<form id="cmp-schedule-form" class="form-grid cmp-block"><input type="hidden" name="id" value="${esc(c.id)}"><input type="hidden" name="expectedRevision" value="${c.revision}"><input type="hidden" name="confirmAudience" value="${p ? p.eligible : ''}">
        <label class="field">Enviar (vacío = ahora)<input type="datetime-local" name="scheduledAt"></label><div class="actions"><button class="btn primary" type="submit" ${p && p.eligible > 0 && !p.overLimit ? '' : 'disabled'}>${p ? `Programar para ${p.eligible} ${p.eligible === 1 ? 'persona' : 'personas'}` : 'Calcula la vista previa primero'}</button></div><div class="ops-feedback" role="status"></div></form>`
          : ''
      }
      ${
        c.stats.recipients
          ? `<section class="cmp-block"><h3>Resultados</h3>${funnel(c.stats)}${c.stats.skippedReasons.length ? `<p class="crm-hint">Omitidos: ${c.stats.skippedReasons.map(r => esc(r.label) + ' (' + r.count + ')').join(' · ')}</p>` : ''}<p class="crm-hint">Respondieron = escribieron en los 7 días siguientes al envío. Costo estimado: ${esc(c.stats.cost.label)} (tarifa de marketing).</p></section>
        <section class="cmp-block"><h3>Destinatarios</h3><div class="fin-table-wrap"><table class="leg-table"><thead><tr><th>Contacto</th><th>Canal</th><th>Estado</th><th>Entrega</th><th>Respondió</th></tr></thead><tbody>${rec.recipients.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(CHANNELS[r.channel] || r.channel)}</td><td>${chip(STATE[r.state][0], STATE[r.state][1])}${r.reason ? `<br><small>${esc(r.reason)}</small>` : ''}</td><td>${r.delivery ? esc(DELIVERY[r.delivery] || r.delivery) : '—'}</td><td>${r.replied ? 'Sí' : '—'}</td></tr>`).join('')}</tbody></table></div>${rec.total > rec.recipients.length ? note('Se muestran los primeros ' + rec.recipients.length + ' de ' + rec.total + '.') : ''}</section>`
          : ''
      }
      <section class="cmp-block"><h3>Bitácora</h3><ol class="co-timeline">${events.map(e => `<li><time>${stamp(e.created_at)}</time><span>${esc(KIND[e.kind] || e.kind)}${e.actor_name ? ' · ' + esc(e.actor_name) : ''}</span></li>`).join('')}</ol></section></div>`,
    );
  }
  function previewBox(p) {
    return `<div class="cmp-preview"><div class="ops-stats co-stats"><div class="ops-stat active"><strong>${p.willSend}</strong><span>Recibirían el mensaje</span></div><div class="ops-stat"><strong>${p.total - p.eligible}</strong><span>Excluidos</span></div><div class="ops-stat"><strong>${esc(p.cost.label)}</strong><span>Costo estimado</span></div></div>
      ${p.excluded.length ? `<ul class="cn-list">${p.excluded.map(e => `<li>${esc(e.label)}: <strong>${e.count}</strong></li>`).join('')}</ul>` : ''}
      ${p.overLimit ? `<p class="ops-feedback">El público supera el máximo por campaña de la marca (${p.maxAudience}). Acota el segmento.</p>` : ''}
      ${p.message ? `<h3 class="rcp-subtitle">Así se vería</h3><pre class="cmp-message">${esc(p.message.text)}</pre><small class="crm-hint">${p.message.hasFlyer ? 'Incluye flyer. ' : ''}Categoría marketing. Los precios y fechas salen del catálogo vigente al momento de enviar.</small>` : p.eligible ? '<p class="ops-feedback">La plantilla no se puede preparar con la oferta vigente.</p>' : ''}
      ${p.sample.length ? `<p class="crm-hint">Por ejemplo: ${p.sample.map(s => esc(s.name)).join(', ')}${p.eligible > p.sample.length ? ' y ' + (p.eligible - p.sample.length) + ' más' : ''}. Ritmo: un mensaje cada ${p.paceSeconds} s (unos ${p.estimatedMinutes} min).</p>` : ''}
      ${p.enabled ? '' : '<p class="ops-feedback">Las campañas o la automatización de esta marca están apagadas: no se podrá programar.</p>'}</div>`;
  }
  function settingsForm(id) {
    const s = settings.find(x => x.brand_id === id);
    if (!s) return;
    showModal(
      'Ajustes de campañas · ' + s.brand_name,
      `<form id="cmp-settings-form" class="form-grid"><input type="hidden" name="brandId" value="${esc(id)}"><input type="hidden" name="expectedRevision" value="${s.revision}">
      <label class="field">Separación mínima entre campañas por contacto (horas)<input name="minGapHours" type="number" min="0" max="720" required value="${s.min_gap_hours}"></label>
      <label class="field">Segundos entre envíos<input name="paceSeconds" type="number" min="1" max="60" required value="${s.pace_seconds}"></label>
      <label class="field">Público máximo por campaña<input name="maxAudience" type="number" min="1" max="20000" required value="${s.max_audience}"></label>
      ${note('La separación evita saturar a una misma persona; el ritmo reparte los envíos para no mandar todo de golpe.')}
      <div class="actions"><button class="btn primary" type="submit">Guardar</button></div><div class="ops-feedback" role="status"></div></form>`,
    );
  }

  async function action(name, el) {
    try {
      if (name === 'cmp-new') {
        editor(null);
        return true;
      }
      if (name === 'cmp-edit') {
        editor(list.find(c => c.id === el.dataset.id));
        return true;
      }
      if (name === 'cmp-detail') {
        preview = null;
        previewFor = null;
        await detail(el.dataset.id);
        return true;
      }
      if (name === 'cmp-preview') {
        preview = (await api('/api/campaigns/' + el.dataset.id + '/preview', { method: 'POST', body: {} })).preview;
        previewFor = el.dataset.id;
        await detail(el.dataset.id);
        return true;
      }
      if (name === 'cmp-settings') {
        settingsForm(el.dataset.id);
        return true;
      }
      if (name === 'cmp-toggle') {
        const s = settings.find(x => x.brand_id === el.dataset.id);
        await api('/api/campaigns/settings/' + el.dataset.id, {
          method: 'PATCH',
          body: { enabled: !s.enabled, expectedRevision: Number(el.dataset.revision) },
        });
        toast(s.enabled ? 'Campañas apagadas.' : 'Campañas encendidas.');
        return 'reload';
      }
      if (name === 'cmp-cancel') {
        if (!confirm('¿Cancelar esta campaña? Se detienen los envíos que faltan; lo ya enviado se conserva.'))
          return true;
        await api('/api/campaigns/' + el.dataset.id + '/cancel', {
          method: 'POST',
          body: { expectedRevision: Number(el.dataset.revision) },
        });
        toast('Campaña cancelada.');
        $('#modal')?.close();
        return 'reload';
      }
    } catch (e) {
      toast(e.message);
      return true;
    }
    return false;
  }
  async function change(el) {
    if (el.id === 'cmp-brand') {
      const f = el.form,
        carry = { title: f.title.value };
      editor(null, el.value, carry);
      return true;
    }
    return false;
  }
  async function submit(form) {
    const id = form.getAttribute('id'),
      feedback = msg => {
        const f = form.querySelector('.ops-feedback');
        if (f) f.textContent = msg;
      };
    try {
      if (id === 'cmp-form') {
        const f = new FormData(form),
          cid = f.get('id'),
          payload = body(form);
        const out = cid
          ? await api('/api/campaigns/' + cid, {
              method: 'PATCH',
              body: { ...payload, expectedRevision: Number(f.get('expectedRevision')) },
            })
          : await api('/api/campaigns', { method: 'POST', body: { ...payload, clientRef: crypto.randomUUID() } });
        toast('Borrador guardado. Revisa la vista previa antes de programar.');
        preview = null;
        previewFor = null;
        await load();
        await detail(out.campaign.id);
        return 'reload';
      }
      if (id === 'cmp-settings-form') {
        const f = new FormData(form);
        await api('/api/campaigns/settings/' + f.get('brandId'), {
          method: 'PATCH',
          body: {
            minGapHours: Number(f.get('minGapHours')),
            paceSeconds: Number(f.get('paceSeconds')),
            maxAudience: Number(f.get('maxAudience')),
            expectedRevision: Number(f.get('expectedRevision')),
          },
        });
        toast('Ajustes guardados.');
        $('#modal')?.close();
        return 'reload';
      }
      if (id === 'cmp-schedule-form') {
        const f = new FormData(form),
          when = f.get('scheduledAt'),
          payload = {
            expectedRevision: Number(f.get('expectedRevision')),
            confirmAudience: Number(f.get('confirmAudience')),
          };
        if (when) payload.scheduledAt = new Date(when).getTime();
        const out = await api('/api/campaigns/' + f.get('id') + '/schedule', { method: 'POST', body: payload });
        toast(when ? 'Campaña programada.' : 'Campaña en marcha.');
        preview = null;
        previewFor = null;
        await load();
        await detail(out.campaign.id);
        return 'reload';
      }
    } catch (e) {
      feedback(e.message);
      toast(e.message);
      return true;
    }
    return false;
  }
  return {
    load,
    html,
    action,
    change,
    submit,
    refreshOpen: async () => {
      if (openId && $('#modal')?.open && $('.cmp-detail')) {
        await load();
        await detail(openId);
      }
    },
  };
};
