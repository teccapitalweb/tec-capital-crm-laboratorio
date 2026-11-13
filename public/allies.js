// Aliados (docs/PLAN_ALIADOS.md): el panel RH de IPCIL dentro del CRM. Postulaciones de academias al programa «Aliado Certificador» (con el
// compromiso de contactarlas en menos de 24 horas), solicitudes de las marcas para vincular su WhatsApp y, para administración, quién
// tiene la función de RH. Todo se calcula en el servidor; aquí sólo se muestra. No manda correos: la invitación es un texto para copiar.
window.createAlliesUI = function ({ state, api, esc, icon, showModal, toast }) {
  const $ = s => document.querySelector(s),
    admin = () => state.user?.role === 'admin';
  let allowed = null,
    formEnabled = false,
    sub = 'applications',
    status = 'all',
    query = '',
    data = {};
  const chip = (label, kind = '') => `<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const stamp = t =>
    t
      ? new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(
          t,
        )
      : '—';
  const KIND = { new: 'high', contacted: '', approved: 'good', rejected: 'urgent' };
  const wa = n => `https://wa.me/52${String(n).replace(/\D/g, '')}`;
  const link = u =>
    /^https?:\/\//i.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>` : esc(u);

  async function probe() {
    if (allowed === null) {
      try {
        const r = await api('/api/allies/me');
        allowed = r.allowed;
        formEnabled = r.formEnabled;
      } catch {
        allowed = false;
      }
    }
    return allowed;
  }
  async function load() {
    if (sub === 'applications')
      data.apps = await api(
        '/api/allies?' +
          new URLSearchParams({ ...(status !== 'all' ? { status } : {}), ...(query ? { q: query } : {}) }),
      );
    if (sub === 'requests') data.reqs = await api('/api/channel-requests');
    if (sub === 'access' && admin()) data.access = await api('/api/allies/access');
  }

  // ---- Postulaciones
  function row(r) {
    return `<article class="aly-row ${r.overdue ? 'late' : ''}"><div class="aly-main"><div class="ops-card-top"><strong>${esc(r.academy)}</strong>${chip(r.statusLabel, KIND[r.status])}${r.overdue ? chip('Más de 24 h sin contactar', 'urgent') : ''}${r.status === 'approved' ? chip(r.invitedAt ? 'Invitación enviada' : 'Falta enviar la invitación', r.invitedAt ? 'good' : 'high') : ''}</div>
      <small>${esc(r.contactName)} · ${esc([r.city, r.state].filter(Boolean).join(', ') || 'Sin ubicación')} · ${esc(r.sector || 'Sin sector')}${r.studentsMonth ? ' · ' + esc(r.studentsMonth) + ' alumnos/mes' : ''} · ${esc(r.issuesLabel)}</small>
      <small><a href="${wa(r.whatsapp)}" target="_blank" rel="noopener noreferrer">WhatsApp ${esc(r.whatsapp)}</a> · <a href="mailto:${esc(r.email)}">${esc(r.email)}</a> · recibida ${esc(stamp(r.createdAt))}${r.hoursWaiting !== null ? ' (hace ' + r.hoursWaiting + ' h)' : ''}${r.source === 'public' ? ' · por el formulario público' : ''}</small>
      ${r.contactNote || r.contactedBy ? `<small>Contactada por ${esc(r.contactedBy || '—')} el ${esc(stamp(r.contactedAt))}${r.contactNote ? ': «' + esc(r.contactNote) + '»' : ''}</small>` : ''}
      ${r.decidedBy ? `<small>${r.status === 'approved' ? 'Aprobada' : 'Rechazada'} por ${esc(r.decidedBy)} el ${esc(stamp(r.decidedAt))}${r.decisionNote ? ': «' + esc(r.decisionNote) + '»' : ''}</small>` : ''}
      ${r.invitedAt ? `<small>Invitación registrada por ${esc(r.invitedBy || '—')} el ${esc(stamp(r.invitedAt))}${r.inviteNote ? ': «' + esc(r.inviteNote) + '»' : ''}</small>` : ''}</div>
      <div class="actions"><button type="button" class="btn" data-action="aly-file" data-id="${esc(r.id)}">Ver ficha</button>${r.status === 'new' ? `<button type="button" class="btn" data-action="aly-note" data-op="contacted" data-id="${esc(r.id)}">Ya la contacté</button>` : ''}${['new', 'contacted'].includes(r.status) ? `<button type="button" class="btn primary" data-action="aly-note" data-op="approve" data-id="${esc(r.id)}">Aprobar</button><button type="button" class="btn" data-action="aly-note" data-op="reject" data-id="${esc(r.id)}">Rechazar</button>` : ''}${r.status === 'approved' ? `<button type="button" class="btn primary" data-action="aly-invite" data-id="${esc(r.id)}">${r.invitedAt ? 'Ver o reenviar invitación' : 'Preparar invitación'}</button>` : ''}</div></article>`;
  }
  function appsHtml() {
    const a = data.apps;
    if (!a) return '<div class="loading-message">Cargando…</div>';
    const c = a.counts,
      tiles = [
        ['all', 'Recibidas', c.total],
        ['new', 'Por contactar', c.new, c.new ? 'high' : ''],
        ['contacted', 'Contactadas', c.contacted],
        ['approved', 'Aprobadas', c.approved, 'good'],
        ['rejected', 'Rechazadas', c.rejected],
      ];
    return `<div class="aly-tiles">${tiles.map(([id, t, n, k]) => `<button type="button" data-action="aly-filter" data-id="${id}" class="aly-tile ${status === id ? 'active' : ''} ${k || ''}"><strong>${n}</strong><span>${esc(t)}</span></button>`).join('')}</div>
      <div class="crm-toolbar"><label class="qr-search"><span class="sr-only">Buscar postulaciones</span>${icon('search')}<input id="aly-search" type="search" placeholder="Buscar academia, contacto, correo o ciudad (Enter)" value="${esc(query)}" autocomplete="off"></label><button type="button" class="btn primary" data-action="aly-new">${icon('plus')} Nueva postulación</button></div>
      <p class="crm-hint">Programa Aliado Certificador · compromiso: contactar en menos de ${a.slaHours} horas${c.overdue ? ' · <strong>' + c.overdue + ' fuera de tiempo</strong>' : ''}. ${formEnabled ? 'El formulario público está encendido en <code>/aliados</code>.' : 'El formulario público está apagado; las postulaciones se capturan aquí a mano.'}</p>
      ${a.rows.length ? `<div class="aly-list">${a.rows.map(row).join('')}</div>` : `<div class="crm-empty">${icon('handshake')}<h3>Sin postulaciones</h3><p>${status === 'all' && !query ? 'Cuando una academia postule, o la captures aquí, aparece en esta bandeja.' : 'Nada con ese filtro.'}</p></div>`}`;
  }

  // ---- Solicitudes de vinculación de WhatsApp
  function reqsHtml() {
    const r = data.reqs;
    if (!r) return '<div class="loading-message">Cargando…</div>';
    return `<div class="crm-toolbar"><p>Marcas que piden que alguien del equipo les ayude a vincular su WhatsApp. ${r.pending ? '<strong>' + r.pending + ' por llamar.</strong>' : 'Sin pendientes.'}</p><button type="button" class="btn primary" data-action="aly-req-new">${icon('plus')} Registrar solicitud</button></div>
      ${
        r.rows.length
          ? `<div class="aly-list">${r.rows
              .map(
                x => `<article class="aly-row ${x.status === 'contacted' ? 'done' : ''}"><div class="aly-main"><div class="ops-card-top"><strong>${esc(x.brand)}</strong>${chip(x.status === 'pending' ? 'Por llamar' : 'Contactada', x.status === 'pending' ? 'high' : 'good')}</div>
        <small>${esc(x.name)}${x.role ? ' (' + esc(x.role) + ')' : ''}${x.email ? ' · ' + esc(x.email) : ''} · ${esc(stamp(x.createdAt))}${x.requestedBy ? ' · pedida por ' + esc(x.requestedBy) : ''}</small>
        <small><b>${esc(x.phone)}</b>${x.schedule ? ' · ' + esc(x.schedule) : ''} · <a href="${wa(x.phone)}" target="_blank" rel="noopener noreferrer">Abrir WhatsApp</a></small>${x.note ? `<small>«${esc(x.note)}»</small>` : ''}
        ${x.contactedBy ? `<small>Contactada por ${esc(x.contactedBy)} el ${esc(stamp(x.contactedAt))}${x.contactNote ? ': «' + esc(x.contactNote) + '»' : ''}</small>` : ''}</div>${x.status === 'pending' ? `<div class="actions"><button type="button" class="btn primary" data-action="aly-note" data-op="req" data-id="${esc(x.id)}">Ya la contacté</button></div>` : ''}</article>`,
              )
              .join('')}</div>`
          : `<div class="crm-empty">${icon('phone')}<h3>Sin solicitudes</h3><p>Cuando una marca pida ayuda para vincular su WhatsApp, aparece aquí.</p></div>`
      }`;
  }

  // ---- Acceso (administración)
  function accessHtml() {
    const a = data.access;
    if (!a) return '<div class="loading-message">Cargando…</div>';
    return `<section class="crm-panel"><h2>Quién lleva Aliados (RH)</h2><p class="crm-hint">Administración siempre tiene acceso. Las personas con esta función ven las postulaciones y las solicitudes de WhatsApp y reciben aviso de las nuevas. Son datos personales de terceros: dala sólo a quien los necesite.</p><div class="ads-access">${a.members.map(m => `<div class="ads-access-row"><div><strong>${esc(m.name)}</strong><small>@${esc(m.username)} · ${m.admin ? 'Administración' : 'Equipo'}${m.disabled ? ' · desactivado' : ''}</small></div>${m.admin ? chip('Siempre') : `<button type="button" class="btn ${m.enabled ? '' : 'primary'}" data-action="aly-access" data-id="${esc(m.id)}" data-on="${m.enabled ? '0' : '1'}">${m.enabled ? 'Quitar función' : 'Dar función de RH'}</button>`}</div>`).join('')}</div></section>`;
  }

  function html() {
    const tabs = [
      ['applications', 'Postulaciones'],
      ['requests', 'Vincular WhatsApp'],
      ...(admin() ? [['access', 'Quién lleva RH']] : []),
    ];
    const body = sub === 'applications' ? appsHtml() : sub === 'requests' ? reqsHtml() : accessHtml();
    const n = data.apps?.counts?.new || 0;
    return `<div class="ads-tabs" role="tablist">${tabs.map(([id, t]) => `<button type="button" role="tab" aria-selected="${sub === id}" data-action="aly-sub" data-id="${id}" class="${sub === id ? 'active' : ''}">${esc(t)}${id === 'applications' && n ? ` <span class="ops-counter">${n}</span>` : ''}</button>`).join('')}</div>${body}`;
  }

  // ---- ventanas
  function appForm() {
    showModal(
      'Nueva postulación',
      `<form id="aly-new-form" class="form-grid">
      <label class="field">Academia<input name="academy" required maxlength="120"></label><label class="field">Contacto<input name="contactName" required maxlength="100"></label>
      <label class="field">WhatsApp (10 dígitos)<input name="whatsapp" required inputmode="numeric" maxlength="16"></label><label class="field">Correo<input name="email" type="email" required maxlength="120"></label>
      <label class="field">Ciudad<input name="city" maxlength="60"></label><label class="field">Estado<input name="state" maxlength="60"></label>
      <label class="field">Sector<input name="sector" maxlength="60" placeholder="Salud, Veterinaria…"></label><label class="field">Alumnos al mes<input name="studentsMonth" maxlength="40"></label>
      <label class="field">Años operando<input name="years" maxlength="20"></label><label class="field">¿Emite certificados?<select name="issuesCertificates"><option value="">No indica</option><option value="si">Sí</option><option value="no">No</option><option value="a_veces">A veces</option></select></label>
      <label class="field">Sitio web o redes<input name="web" maxlength="200"></label><label class="field">¿Cómo conoció el programa?<input name="heardFrom" maxlength="120"></label>
      <label class="field">Mensaje<textarea name="message" rows="3" maxlength="1000"></textarea></label>
      <div class="actions"><button class="btn primary" type="submit">Guardar postulación</button></div><div class="ops-feedback" role="status"></div></form>`,
    );
  }
  function fileModal(r) {
    const f = (l, v) => `<div class="aly-field"><b>${esc(l)}</b><span>${v}</span></div>`;
    showModal(
      r.academy,
      `<div class="aly-file">${f('Contacto', esc(r.contactName))}${f('Ubicación', esc([r.city, r.state].filter(Boolean).join(', ') || '—'))}${f('Correo', `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>`)}${f('WhatsApp', `<a href="${wa(r.whatsapp)}" target="_blank" rel="noopener noreferrer">${esc(r.whatsapp)}</a>`)}${f('Sector', esc(r.sector || '—'))}${f('Años operando', esc(r.years || '—'))}${f('Alumnos al mes', esc(r.studentsMonth || '—'))}${f('¿Emite certificados?', esc(r.issuesLabel))}${f('Web / redes', r.web ? link(r.web) : '—')}${f('Cómo conoció el programa', esc(r.heardFrom || '—'))}${f('Recibida', esc(stamp(r.createdAt)))}${f('Mensaje', esc(r.message || '—'))}</div>`,
    );
  }
  const NOTES = {
    contacted: ['Marcar como contactada', 'Nota (opcional)', 'Ej: hablamos por WhatsApp, le interesa'],
    approve: ['Aprobar postulación', 'Nota (opcional)', 'Ej: cumple el perfil'],
    reject: ['Rechazar postulación', 'Motivo (obligatorio)', 'Ej: no emite certificados ni planea hacerlo'],
    req: ['Marcar solicitud contactada', 'Nota (opcional)', 'Ej: quedamos el jueves a las 11'],
  };
  function noteForm(op, id) {
    const [title, label, hint] = NOTES[op];
    showModal(
      title,
      `<form id="aly-note-form" class="form-grid"><input type="hidden" name="op" value="${esc(op)}"><input type="hidden" name="id" value="${esc(id)}"><label class="field">${esc(label)}<input name="note" maxlength="140" placeholder="${esc(hint)}" ${op === 'reject' ? 'required minlength="5"' : ''}></label><div class="actions"><button class="btn primary" type="submit">Guardar</button></div><div class="ops-feedback" role="status"></div></form>`,
    );
  }
  async function inviteModal(id) {
    const r = data.apps.rows.find(x => x.id === id),
      t = await api('/api/allies/' + id + '/invite-text');
    showModal(
      'Invitación para ' + (r?.academy || ''),
      `<p class="crm-hint">Este texto no se envía desde aquí: cópialo y mándalo tú por correo o WhatsApp. Agrega el enlace de registro antes de enviarlo.</p><label class="field">Texto<textarea id="aly-invite-text" rows="7">${esc(t.text)}</textarea></label>
      <div class="actions"><button type="button" class="btn" data-action="aly-copy">${icon('copy')} Copiar texto</button><a class="btn" href="${wa(t.whatsapp)}" target="_blank" rel="noopener noreferrer">Abrir WhatsApp</a><a class="btn" href="mailto:${esc(t.email)}">Abrir correo</a></div>
      <form id="aly-note-form" class="form-grid"><input type="hidden" name="op" value="invited"><input type="hidden" name="id" value="${esc(id)}"><label class="field">Cuando lo envíes, regístralo (nota opcional)<input name="note" maxlength="140" placeholder="Ej: enviada por WhatsApp"></label><div class="actions"><button class="btn primary" type="submit">Ya la envié</button></div><div class="ops-feedback" role="status"></div></form>`,
    );
  }
  function reqForm() {
    showModal(
      'Registrar solicitud para vincular WhatsApp',
      `<form id="aly-req-form" class="form-grid"><label class="field">Marca<select name="brandId" required>${state.brands.map(b => `<option value="${esc(b.id)}" ${b.id === state.brand ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
      <label class="field">Nombre de quien pide<input name="name" required maxlength="100"></label><label class="field">Puesto<input name="role" maxlength="60"></label><label class="field">Teléfono (10 dígitos)<input name="phone" required inputmode="numeric" maxlength="16"></label>
      <label class="field">Correo (opcional)<input name="email" type="email" maxlength="120"></label><label class="field">Mejor horario para llamar<input name="schedule" maxlength="100" placeholder="Lunes a viernes de 10 a 2"></label><label class="field">Nota<textarea name="note" rows="2" maxlength="300"></textarea></label>
      <div class="actions"><button class="btn primary" type="submit">Registrar</button></div><div class="ops-feedback" role="status"></div></form>`,
    );
  }

  async function action(name, el) {
    if (name === 'aly-sub') {
      sub = el.dataset.id;
      return 'reload';
    }
    if (name === 'aly-filter') {
      status = el.dataset.id;
      return 'reload';
    }
    if (name === 'aly-new') {
      appForm();
      return true;
    }
    if (name === 'aly-file') {
      const r = data.apps.rows.find(x => x.id === el.dataset.id);
      if (r) fileModal(r);
      return true;
    }
    if (name === 'aly-note') {
      noteForm(el.dataset.op, el.dataset.id);
      return true;
    }
    if (name === 'aly-invite') {
      await inviteModal(el.dataset.id);
      return true;
    }
    if (name === 'aly-copy') {
      try {
        await navigator.clipboard.writeText($('#aly-invite-text').value);
        toast('Texto copiado.');
      } catch {
        toast('No se pudo copiar; selecciónalo y cópialo a mano.');
      }
      return true;
    }
    if (name === 'aly-req-new') {
      reqForm();
      return true;
    }
    if (name === 'aly-access') {
      await api('/api/allies/access', {
        method: 'PUT',
        body: { userId: el.dataset.id, enabled: el.dataset.on === '1' },
      });
      toast(el.dataset.on === '1' ? 'Función concedida.' : 'Función retirada.');
      return 'reload';
    }
    return false;
  }
  async function submit(form) {
    const id = form.getAttribute('id'),
      f = Object.fromEntries(new FormData(form)),
      feedback = m => {
        const x = form.querySelector('.ops-feedback');
        if (x) x.textContent = m;
      };
    try {
      if (id === 'aly-new-form')
        await api('/api/allies', { method: 'POST', body: { ...f, clientRef: crypto.randomUUID() } });
      else if (id === 'aly-note-form') {
        if (f.op === 'req')
          await api('/api/channel-requests/' + f.id + '/contacted', { method: 'POST', body: { note: f.note } });
        else
          await api(
            '/api/allies/' +
              f.id +
              '/' +
              { contacted: 'contacted', approve: 'approve', reject: 'reject', invited: 'invited' }[f.op],
            { method: 'POST', body: { note: f.note } },
          );
      } else if (id === 'aly-req-form')
        await api('/api/channel-requests', { method: 'POST', body: { ...f, clientRef: crypto.randomUUID() } });
      else return false;
      $('#modal')?.close();
      toast('Listo.');
      return 'reload';
    } catch (e) {
      feedback(e.message);
      toast(e.message);
      return true;
    }
  }
  return {
    probe,
    load,
    html,
    action,
    submit,
    setQuery: v => {
      query = v;
    },
  };
};
