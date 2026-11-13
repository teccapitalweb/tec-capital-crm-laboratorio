// Agenda de citas (docs/PLAN_AGENDA_CITAS.md): botón «Agendar cita» junto a Programar, la lista de citas de este chat sobre el compositor y, en Mi día,
// las citas de la persona. Sólo para el equipo. Los formularios no usan <form> (se leen al pulsar) y las acciones llevan el prefijo «apt-».
window.createAppointmentsUI = function ({ state, api, esc, icon, toast }) {
  const $ = s => document.querySelector(s);
  const cache = new Map(); // conversationId -> {items}
  let panel = null; // {id, editing, clientRef, f:{...}, busy, touchedReminder}
  const KIND = {
    llamada: ['Llamada', 'phone'],
    videollamada: ['Videollamada', 'video'],
    presencial: ['Presencial', 'map-pin'],
  };
  const when = t =>
    new Date(t).toLocaleString('es-MX', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  const hour = t => new Date(t).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
  const local = t => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const nextAt = (days, h) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(h, 0, 0, 0);
    return d.getTime();
  };
  const monday = () => {
    const d = new Date();
    return nextAt((8 - d.getDay()) % 7 || 7, 10);
  };
  const quick = () => [
    ['Mañana 10:00', nextAt(1, 10)],
    ['Lunes 10:00', monday()],
    ['En 3 días', nextAt(3, 10)],
    ['En 1 semana', nextAt(7, 10)],
  ];
  const chat = id => state.conversations?.find(c => c.id === id) || {};
  const first = id => String(chat(id).customer_name || '').split(/\s+/)[0] || '';
  const phrase = t => {
    const d = new Date(t),
      today = new Date();
    const same = d.toDateString() === today.toDateString();
    const tm = new Date(today.getTime() + 86400e3);
    return (
      (same
        ? 'hoy'
        : d.toDateString() === tm.toDateString()
          ? 'mañana'
          : 'el ' + d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })) +
      ' a las ' +
      hour(t)
    );
  };
  const reminderText = (id, f, at) =>
    `Hola${first(id) ? ' ' + first(id) : ''}, te recuerdo nuestra ${f.kind === 'presencial' ? 'cita presencial' : f.kind === 'videollamada' ? 'videollamada' : 'llamada'} ${phrase(at).replace(/\.+$/, '')}.${f.place ? (f.kind === 'presencial' ? ' Lugar: ' : ' Enlace: ') + f.place : ''}`;
  const sched = id => '/api/conversations/' + id + '/appointments';

  function paint(id) {
    const box = $('#conv-appointments');
    if (!box || box.dataset.id !== id) return;
    const items = cache.get(id)?.items || [],
      pend = items.filter(i => i.state === 'scheduled'),
      past = items
        .filter(i => i.state !== 'scheduled')
        .sort((a, b) => b.startsAt - a.startsAt)
        .slice(0, 2),
      t = Date.now();
    const lab = { done: 'Se hizo', no_show: 'No asistió', cancelled: 'Cancelada' };
    const row = i => {
      const ended = i.state === 'scheduled' && i.endsAt < t,
        started = i.state === 'scheduled' && i.startsAt <= t,
        [kl, ki] = KIND[i.kind] || KIND.llamada;
      return `<div class="sch-row apt-row${i.state === 'scheduled' ? '' : ' sch-past'}">
        <span class="sch-when">${icon(i.state === 'scheduled' ? ki : i.state === 'done' ? 'check' : 'ban')}<b>${i.state === 'scheduled' ? esc(when(i.startsAt)) : esc(lab[i.state])}</b><small> · ${esc(kl)} · ${i.durationMin} min${i.mine ? '' : ' · ' + esc(i.ownerName || 'el equipo')}</small></span>
        <span class="sch-text" title="${esc(i.title)}"><strong>${esc(i.title)}</strong>${i.place ? ' · ' + esc(i.place) : ''}${i.reminder && i.state === 'scheduled' ? ` · <small>recordatorio ${i.reminder.state === 'pending' ? 'programado' : 'no enviado'}</small>` : ''}</span>
        ${i.state === 'scheduled' ? `<span class="sch-actions">${started ? `<button type="button" class="btn" data-action="apt-state" data-state="done" data-id="${esc(i.id)}">Se hizo</button><button type="button" class="btn" data-action="apt-state" data-state="no_show" data-id="${esc(i.id)}">No asistió</button>` : `<button type="button" class="btn" data-action="apt-edit" data-id="${esc(i.id)}">Editar</button>`}<button type="button" class="btn" data-action="apt-state" data-state="cancelled" data-id="${esc(i.id)}">Cancelar</button></span>` : ''}
        ${ended ? '<small class="sch-reason">Ya terminó: márcala como hecha o como no asistió.</small>' : ''}
      </div>`;
    };
    const p = panel && panel.id === id ? panel : null,
      f = p?.f;
    const form = p
      ? `<div class="sch-panel apt-panel" role="group" aria-label="${p.editing ? 'Editar cita' : 'Agendar cita'}">
      <label class="sch-field">Título<input type="text" id="apt-title" maxlength="120" value="${esc(f.title)}"></label>
      <div class="apt-grid">
        <label class="sch-field">Tipo<select id="apt-kind">${Object.entries(KIND)
          .map(([k, [l]]) => `<option value="${k}" ${f.kind === k ? 'selected' : ''}>${l}</option>`)
          .join('')}</select></label>
        <label class="sch-field">Duración<select id="apt-dur">${[15, 30, 45, 60, 90, 120].map(m => `<option value="${m}" ${f.durationMin === m ? 'selected' : ''}>${m < 60 ? m + ' min' : m % 60 ? (m / 60).toFixed(1).replace('.5', ':30') + ' h' : m / 60 + ' h'}</option>`).join('')}</select></label>
      </div>
      <div class="sch-field"><span>¿Cuándo?</span><div class="sch-quick">${quick()
        .map(([t, v]) => `<button type="button" class="btn" data-action="apt-pick" data-at="${v}">${esc(t)}</button>`)
        .join('')}</div>
        <input type="datetime-local" id="apt-when" aria-label="Fecha y hora de la cita" value="${esc(f.when)}" min="${local(Date.now() + 60e3)}"></div>
      <label class="sch-field">${f.kind === 'presencial' ? 'Lugar' : 'Enlace o teléfono'}<input type="text" id="apt-place" maxlength="200" value="${esc(f.place)}" placeholder="${f.kind === 'presencial' ? 'Dirección o sala' : 'https://… o número'}"></label>
      <label class="sch-field">Notas para ti<textarea id="apt-notes" rows="2" maxlength="1000">${esc(f.notes)}</textarea></label>
      <label class="sch-check"><input type="checkbox" id="apt-rem" ${f.remind ? 'checked' : ''}> ${p.editing ? 'Programar un recordatorio nuevo para el cliente' : 'Recordarle la cita al cliente'}</label>
      ${
        f.remind
          ? `<div class="sch-field"><span>Avisarle</span><select id="apt-rem-min">${[
              [30, '30 minutos antes'],
              [60, '1 hora antes'],
              [180, '3 horas antes'],
              [1440, '1 día antes'],
            ]
              .map(([m, l]) => `<option value="${m}" ${f.remMin === m ? 'selected' : ''}>${l}</option>`)
              .join(
                '',
              )}</select><textarea id="apt-rem-text" rows="2" maxlength="1000" aria-label="Mensaje del recordatorio">${esc(f.remText)}</textarea><small class="sch-note">Sale como un mensaje programado a tu nombre; no sale si el chat se cierra.</small></div>`
          : ''
      }
      <div class="sch-foot"><small>Si ya tienes otra cita a esa hora, te avisamos.</small><span><button type="button" class="btn" data-action="apt-close">Cerrar</button><button type="button" class="btn primary" data-action="apt-save" ${p.busy ? 'disabled' : ''}>${p.busy ? 'Guardando…' : p.editing ? 'Guardar cambios' : 'Agendar'}</button></span></div>
    </div>`
      : '';
    box.innerHTML =
      (pend.length || past.length
        ? `<div class="sch-list" aria-label="Citas de esta conversación">${pend.map(row).join('')}${past.map(row).join('')}</div>`
        : '') + form;
    window.lucide?.createIcons({ attrs: { 'stroke-width': 1.7 } });
  }
  async function load(id) {
    try {
      const r = await api(sched(id));
      cache.set(id, { items: r.items });
    } catch {
      if (!cache.has(id)) cache.set(id, { items: [] });
    }
    paint(id);
  }
  function mount(c) {
    const box = $('#conv-appointments');
    if (!box) return;
    box.dataset.id = c.id;
    if (cache.has(c.id)) paint(c.id);
    load(c.id);
  }
  function open(id, editing = null) {
    const kind = editing?.kind || 'llamada';
    panel = {
      id,
      editing,
      clientRef: crypto.randomUUID(),
      busy: false,
      touchedText: false,
      f: {
        title: editing ? editing.title : `${KIND[kind][0]} con ${first(id) || 'el cliente'}`,
        kind,
        durationMin: editing?.durationMin || 30,
        when: editing ? local(editing.startsAt) : '',
        place: editing?.place || '',
        notes: editing?.notes || '',
        remind: false,
        remMin: 60,
        remText: '',
      },
    };
    refreshText();
    paint(id);
    $('#apt-title')?.focus();
  }
  function read() {
    if (!panel) return;
    const f = panel.f,
      g = s => $(s);
    if (g('#apt-title')) f.title = g('#apt-title').value;
    if (g('#apt-kind')) f.kind = g('#apt-kind').value;
    if (g('#apt-dur')) f.durationMin = Number(g('#apt-dur').value);
    if (g('#apt-when')) f.when = g('#apt-when').value;
    if (g('#apt-place')) f.place = g('#apt-place').value;
    if (g('#apt-notes')) f.notes = g('#apt-notes').value;
    if (g('#apt-rem')) f.remind = g('#apt-rem').checked;
    if (g('#apt-rem-min')) f.remMin = Number(g('#apt-rem-min').value);
    if (g('#apt-rem-text')) {
      if (g('#apt-rem-text').value !== f.remText) panel.touchedText = true;
      f.remText = g('#apt-rem-text').value;
    }
  }
  // El texto del recordatorio se arma solo con la hora elegida, mientras la persona no lo haya escrito a mano.
  function refreshText() {
    if (!panel || panel.touchedText) return;
    const at = panel.f.when ? new Date(panel.f.when).getTime() : NaN;
    if (Number.isFinite(at)) panel.f.remText = reminderText(panel.id, panel.f, at);
  }
  async function save(retryOverlap = false) {
    read();
    const id = panel.id,
      f = panel.f,
      at = f.when ? new Date(f.when).getTime() : NaN;
    if (!f.title.trim()) return toast('Ponle un título a la cita.');
    if (!Number.isFinite(at)) return toast('Elige la fecha y la hora.');
    const body = {
      title: f.title,
      startsAt: at,
      durationMin: f.durationMin,
      kind: f.kind,
      place: f.place,
      notes: f.notes,
    };
    if (f.remind && f.remText.trim()) body.reminder = { text: f.remText, minutesBefore: f.remMin };
    if (retryOverlap) body.allowOverlap = true;
    panel.busy = true;
    paint(id);
    try {
      const r = panel.editing
        ? await api('/api/appointments/' + panel.editing.id, {
            method: 'PATCH',
            body: { ...body, expectedRevision: panel.editing.revision },
          })
        : await api(sched(id), { method: 'POST', body: { ...body, clientRef: panel.clientRef } });
      toast(r.warning || (panel.editing ? 'Cambios guardados.' : 'Cita agendada para ' + when(at) + '.'));
      panel = null;
      await load(id);
    } catch (e) {
      if (panel) panel.busy = false;
      if (
        /empalmarlas/.test(e.message || '') &&
        confirm(
          e.message.replace(' Elige otra o confirma que quieres empalmarlas.', '') + '\n\n¿Agendar de todos modos?',
        )
      )
        return save(true);
      toast(e.message);
      if (panel) paint(id);
    }
  }
  async function action(name, el) {
    const id = state.selected;
    if (name === 'apt-open') {
      if (panel && panel.id === id) {
        panel = null;
        paint(id);
      } else open(id);
      return true;
    }
    if (name === 'apt-close') {
      panel = null;
      paint(id);
      return true;
    }
    if (name === 'apt-pick') {
      read();
      panel.f.when = local(Number(el.dataset.at));
      refreshText();
      paint(id);
      return true;
    }
    if (name === 'apt-save') {
      await save();
      return true;
    }
    const item = (cache.get(id)?.items || []).find(i => i.id === el.dataset.id);
    if (name === 'apt-edit') {
      if (item) open(id, item);
      return true;
    }
    if (name === 'apt-state') {
      try {
        await api('/api/appointments/' + el.dataset.id + '/state', {
          method: 'POST',
          body: { state: el.dataset.state },
        });
        toast(
          { done: 'Cita marcada como hecha.', no_show: 'Marcada como no asistió.', cancelled: 'Cita cancelada.' }[
            el.dataset.state
          ],
        );
      } catch (e) {
        toast(e.message);
      }
      await load(id);
      return true;
    }
    return false;
  }
  // El panel y la lista se repintan con cada cambio del chat; si la persona cambia el tipo o la hora, se actualiza el texto del recordatorio.
  document.addEventListener('change', e => {
    if (!panel || !e.target.id?.startsWith('apt-') || e.target.id === 'apt-rem-text') return;
    read();
    refreshText();
    paint(panel.id);
  });

  // Mi día: mis citas pendientes de todas mis marcas (sólo si hay alguna). Cada fila abre el chat.
  async function mountDay() {
    const box = $('#day-appointments');
    if (!box) return;
    try {
      const r = await api('/api/appointments');
      if (!document.body.contains(box)) return;
      if (!r.items.length) {
        box.hidden = true;
        box.innerHTML = '';
        return;
      }
      const t = Date.now();
      box.hidden = false;
      box.innerHTML = `<div class="panel-title"><h2>Mis citas</h2><small class="sch-day-count">${r.items.length} por venir</small></div>${r.items
        .slice(0, 6)
        .map(
          i =>
            `<button type="button" class="attention-row sch-day-row" data-action="crm-chat" data-id="${esc(i.conversationId)}"><span class="avatar">${esc((i.customerName || '?').slice(0, 2).toUpperCase())}</span><span><strong>${esc(i.title)}</strong><small>${esc(i.customerName || 'Cliente')} · ${esc(i.brandName || '')}</small><small class="sch-day-text">${esc(when(i.startsAt))} · ${esc((KIND[i.kind] || KIND.llamada)[0])} · ${i.durationMin} min${i.endsAt < t ? ' · <b>ya terminó, ciérrala</b>' : ''}</small></span></button>`,
        )
        .join('')}${r.items.length > 6 ? `<p class="sch-day-more">y ${r.items.length - 6} más</p>` : ''}`;
    } catch {
      box.hidden = true;
    }
  }
  return { mount, mountDay, action };
};
