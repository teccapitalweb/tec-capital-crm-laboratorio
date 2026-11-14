window.createCRMUI = function ({
  state,
  api,
  esc,
  icon,
  showModal,
  toast,
  icons,
  refresh,
  shell,
  setView,
  selectConversation,
  load,
  entry,
  afterDay,
}) {
  const labels = {
    day: 'Mi día',
    contacts: 'Contactos',
    opportunities: 'Oportunidades',
    tasks: 'Tareas',
    team: 'Equipo y accesos',
    settings: 'Mi configuración',
  };
  const stageLabels = {
    nuevo: 'Nuevo interés',
    interesado: 'En conversación',
    inscripcion: 'Inscripción solicitada',
    ganada: 'Ganada · prueba',
    perdida: 'No continuó',
  };
  let data = { contacts: [], opportunities: [], tasks: [], members: [], preferences: {} },
    renderVersion = 0,
    query = '';
  const pushUI = window.createPushUI({ state, api, esc, icon, toast });
  const quickUI = window.createQuickRepliesUI({ state, api, esc, icon, showModal, toast });
  const securityUI = window.createSecurityUI({
    state,
    api,
    esc,
    icon,
    showModal,
    toast,
    refreshTeam: () => renderTeam(),
  });
  const contactsUI = window.createContactsUI({
    state,
    api,
    esc,
    icon,
    showModal,
    toast,
    getData: () => data,
    rerender: () => render(),
    openContact: id => showContact(id),
  });
  const personsUI = window.createPersonsUI({
    state,
    api,
    esc,
    icon,
    showModal,
    toast,
    openContact: id => showContact(id),
    openConversation: async id => {
      document.querySelector('#modal')?.close();
      state.channel = 'all';
      state.filter = 'all';
      state.query = '';
      setView('inbox');
      await selectConversation(id);
    },
    rerender: () => render(),
  });
  const $ = s => document.querySelector(s),
    brand = id => state.brands.find(b => b.id === id)?.name || '',
    stamp = t =>
      new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(
        t,
      );
  const visible = items =>
    items.filter(
      x =>
        (state.brand === 'all' || x.brand_id === state.brand) &&
        (!query || JSON.stringify(x).toLowerCase().includes(query.toLowerCase())),
    );
  const options = (items, value, label, selected = '') =>
    items
      .map(
        x =>
          `<option value="${esc(x[value])}" ${x[value] === selected ? 'selected' : ''}>${esc(typeof label === 'function' ? label(x) : x[label])}</option>`,
      )
      .join('');
  const ownerOptions = (brandId, selected) =>
    '<option value="">Sin asignar</option>' +
    options(
      data.members.filter(m => !m.disabled && m.brandIds.includes(brandId)),
      'id',
      'name',
      selected,
    );
  const localDate = t => {
    const d = new Date(t);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const future = () => localDate(Date.now() + 86400000);
  const field = (label, name, value = '', type = 'text', extra = '') =>
    `<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const blank = (title, copy) => `<div class="crm-empty">${icon('sparkles')}<h2>${title}</h2><p>${copy}</p></div>`;
  const button = (name, label, id = '', klass = '') =>
    `<button class="btn ${klass}" data-action="crm-${name}" data-id="${esc(id)}">${label}</button>`;
  function nav() {
    return [
      ['day', 'sun', 'Mi día'],
      ['contacts', 'contact-round', 'Contactos'],
      ['opportunities', 'columns-3', 'Oportunidades'],
      ['tasks', 'list-checks', 'Tareas'],
      ...(state.user.role === 'admin' ? [['team', 'users-round', 'Equipo']] : []),
      ['settings', 'settings-2', 'Mi configuración'],
    ]
      .map(
        ([id, symbol, label]) =>
          `<button data-view="${id}" class="${state.view === id ? 'active' : ''}" aria-label="${label}" title="${label}">${icon(symbol)}<span class="nav-label-text">${label}</span></button>`,
      )
      .join('');
  }
  const taskRows = items =>
    items.length
      ? items
          .map(
            t =>
              `<div class="crm-task ${t.status !== 'open' ? 'done' : ''}"><button class="task-check" data-action="crm-task-status" data-id="${t.id}" data-status="${t.status === 'open' ? 'done' : 'open'}" aria-label="${t.status === 'open' ? 'Completar' : 'Reabrir'} tarea ${esc(t.title)}" ${t.owner_id && t.owner_id !== state.user.id && state.user.role !== 'admin' ? 'disabled' : ''}>${icon(t.status === 'done' ? 'check' : 'circle')}</button><button class="task-main" data-action="crm-opportunity" data-id="${t.opportunity_id}"><strong>${esc(t.title)}</strong><span>${esc(t.contact_name)} · ${esc(t.course_title)}</span></button><div class="task-meta"><time class="${t.due_at < Date.now() && t.status === 'open' ? 'overdue' : ''}">${stamp(t.due_at)}</time><span>${esc(t.owner_name || 'Sin asignar')} · ${t.status === 'cancelled' ? 'Cancelada' : t.status === 'done' ? 'Completada' : 'Pendiente'}</span></div>${!t.owner_id || t.owner_id === state.user.id || state.user.role === 'admin' ? `<button class="icon-btn" data-action="crm-edit-task" data-id="${t.id}" aria-label="Editar tarea ${esc(t.title)}">${icon('pencil')}</button>` : ''}</div>`,
          )
          .join('')
      : blank('Todo en orden', 'No hay tareas en esta vista.');
  async function render() {
    const view = state.view,
      version = ++renderVersion;
    try {
      const [result, tagInfo] = await Promise.all([api('/api/crm'), api('/api/crm/tags')]);
      if (version !== renderVersion || state.view !== view) return;
      if (!$('#page')) return; // la sesión se cerró mientras llegaba la respuesta: ya no hay dónde pintar
      result.tagInfo = tagInfo;
      data = result;
      draw();
    } catch (e) {
      const page = $('#page');
      if (page && state.view === view)
        page.innerHTML = `<div class="content-page">${blank('No pudimos abrir este espacio', esc(e.message))}${button('reload', 'Volver a intentar')}</div>`;
    }
  }
  function draw() {
    const view = state.view;
    const titles = {
      day: [
        'Tu espacio de trabajo',
        'Hola, ' + state.user.name.split(' ')[0] + '.',
        'Tu siguiente paso, en un solo lugar.',
      ],
      contacts: ['Personas y contexto', 'Contactos', 'Una ficha por persona y marca; todos sus intereses juntos.'],
      opportunities: [
        'Seguimiento comercial',
        'Oportunidades',
        'Cada curso tiene su propio seguimiento. Las ventas son de práctica.',
      ],
      tasks: ['El siguiente paso', 'Tareas', 'Dale continuidad a cada conversación.'],
      team: ['Administración', 'Equipo y accesos', 'Invita a cada asesor y define qué marcas puede atender.'],
      settings: ['A tu manera', 'Mi configuración', 'Tu perfil, firma y disponibilidad para el equipo.'],
    };
    const [over, title, description] = titles[view] || titles.day;
    const add = {
      contacts: button('new-contact', icon('plus') + ' Nuevo contacto', '', 'primary'),
      opportunities: button('new-opportunity', icon('plus') + ' Nueva oportunidad', '', 'primary'),
      tasks: button('new-task', icon('plus') + ' Nueva tarea', '', 'primary'),
      team: button('invite', icon('user-plus') + ' Invitar asesor', '', 'primary'),
    };
    let content = '';
    const opps = visible(data.opportunities),
      tasks = visible(data.tasks),
      contacts = visible(data.contacts).filter(contactsUI.matches);
    if (view === 'day') {
      const mine = tasks.filter(t => t.status === 'open' && t.owner_id === state.user.id),
        end = new Date();
      end.setHours(23, 59, 59, 999);
      const due = mine.filter(t => t.due_at <= end.getTime()),
        unassigned = opps.filter(o => !o.owner_id && !['ganada', 'perdida'].includes(o.stage)),
        pending = state.conversations.filter(
          c => (state.brand === 'all' || c.brand_id === state.brand) && c.status === 'waiting',
        ),
        noNext = opps.filter(
          o => o.owner_id === state.user.id && !o.next_due && !['ganada', 'perdida'].includes(o.stage),
        );
      content = `<div class="day-summary">${[
        [due.length, 'Seguimientos para hoy', 'clock-3'],
        [pending.length, 'Esperando un asesor', 'messages-square'],
        [unassigned.length, 'Intereses sin asignar', 'user-round-plus'],
        [noNext.length, 'Sin próxima tarea', 'calendar-plus'],
      ]
        .map(([n, l, i]) => `<div class="day-stat">${icon(i)}<strong>${n}</strong><span>${l}</span></div>`)
        .join(
          '',
        )}</div><section class="crm-panel day-scheduled" id="day-appointments" hidden></section><section class="crm-panel day-scheduled" id="day-scheduled" hidden></section><div class="day-grid"><section class="crm-panel"><div class="panel-title"><h2>Tu agenda de hoy</h2><button class="text-link" data-view="tasks">Ver todas ${icon('arrow-up-right')}</button></div>${taskRows(due)}</section><section class="crm-panel"><div class="panel-title"><h2>Por atender</h2><button class="text-link" data-view="inbox">Ir a la bandeja ${icon('arrow-up-right')}</button></div>${
        pending
          .slice(0, 6)
          .map(
            c =>
              `<button class="attention-row" data-action="crm-chat" data-id="${c.id}"><span class="avatar">${esc(c.customer_name.slice(0, 2).toUpperCase())}</span><span><strong>${esc(c.customer_name)}</strong><small>${esc(c.brand_name)} · ${esc(c.course_title)}</small></span><span class="channel-chip ${c.channel}">${c.channel === 'facebook' ? 'Facebook' : c.channel === 'instagram' ? 'Instagram' : 'WhatsApp'}</span></button>`,
          )
          .join('') || blank('La bandeja está al día', 'Aquí verás a quienes pidieron atención humana.')
      }</section></div>${
        unassigned.length || noNext.length
          ? `<section class="crm-panel"><div class="panel-title"><h2>Que ningún interés se quede sin seguimiento</h2></div>${[
              ...unassigned,
              ...noNext,
            ]
              .slice(0, 8)
              .map(
                o =>
                  `<button class="crm-list-row" data-action="crm-opportunity" data-id="${o.id}"><span><strong>${esc(o.contact_name)}</strong><small>${esc(o.course_title)} · ${esc(brand(o.brand_id))}</small></span><span class="pill">${o.owner_id ? 'Añadir próxima tarea' : 'Asignar responsable'}</span>${icon('arrow-up-right')}</button>`,
              )
              .join('')}</section>`
          : ''
      }<div class="crm-hint">${icon('flask-conical')} Laboratorio de ventas: estos estados no confirman pagos ni inscripciones reales.</div>`;
    } else if (view === 'contacts') {
      content =
        searchBox() +
        contactsUI.toolbar() +
        `<div class="crm-panel crm-table-wrap"><table class="crm-table"><thead><tr><th>Contacto</th><th>Marca</th><th>Datos de contacto</th><th>Etiquetas</th><th>Intereses activos</th><th></th></tr></thead><tbody>${contacts.map(c => `<tr><td><button class="contact-link" data-action="crm-contact" data-id="${c.id}"><span class="avatar">${esc(c.name.slice(0, 2).toUpperCase())}</span><span><strong>${esc(c.name)}</strong><small>${c.test_number ? 'Perfil #' + c.test_number : 'Contacto manual'}</small></span></button></td><td>${esc(brand(c.brand_id))}</td><td>${esc(c.phone || c.email || 'Por completar')}</td><td>${contactsUI.chips(c)}</td><td>${c.active_interests}</td><td>${button('contact', 'Ver ficha', c.id)}</td></tr>`).join('')}</tbody></table>${!contacts.length ? blank('Aquí empieza la relación', 'Crea un contacto o recibe una conversación en el laboratorio.') : ''}</div>`;
    } else if (view === 'opportunities') {
      content =
        searchBox() +
        `<div class="pipeline">${Object.entries(stageLabels)
          .map(([stage, label]) => {
            const cards = opps.filter(o => o.stage === stage);
            return `<section class="pipeline-column"><div class="pipeline-heading"><h2>${label}</h2><span>${cards.length}</span></div>${cards.map(o => `<button class="opportunity-card" data-action="crm-opportunity" data-id="${o.id}"><span class="course-brand">${esc(brand(o.brand_id))}</span><strong>${esc(o.contact_name)}</strong><p>${esc(o.course_title)}<br>${esc(o.edition_name || '')}</p><div class="opportunity-footer"><span>${esc(o.owner_name || 'Sin responsable')}</span>${icon('arrow-up-right')}</div><small class="${!o.next_due && !['ganada', 'perdida'].includes(stage) ? 'overdue' : ''}">${o.next_due ? 'Próxima tarea: ' + stamp(o.next_due) : ['ganada', 'perdida'].includes(stage) ? 'Seguimiento terminado' : 'Falta próxima tarea'}</small></button>`).join('') || '<p class="column-empty">Sin oportunidades</p>'}</section>`;
          })
          .join('')}</div>`;
    } else if (view === 'tasks') {
      const filter = state.taskFilter || 'mine',
        list = tasks.filter(t =>
          ['done', 'cancelled'].includes(filter)
            ? t.status === filter
            : t.status === 'open' && (filter === 'all' || t.owner_id === state.user.id),
        );
      content =
        searchBox() +
        `<div class="crm-toolbar"><div class="segmented"><button data-action="crm-task-filter" data-id="mine" class="${filter === 'mine' ? 'active' : ''}">Mis pendientes</button><button data-action="crm-task-filter" data-id="all" class="${filter === 'all' ? 'active' : ''}">Del equipo</button><button data-action="crm-task-filter" data-id="done" class="${filter === 'done' ? 'active' : ''}">Completadas</button><button data-action="crm-task-filter" data-id="cancelled" class="${filter === 'cancelled' ? 'active' : ''}">Canceladas</button></div></div><section class="crm-panel">${taskRows(list)}</section>`;
    } else if (view === 'settings') {
      content = `<div class="settings-grid"><section class="crm-panel"><h2>Mi perfil</h2><form id="crm-profile-form" class="form-grid">${field('Nombre visible', 'name', state.user.name, 'text', 'required minlength="2" maxlength="60"')}<label class="field">Disponibilidad<select name="availability"><option value="available" ${data.preferences.availability === 'available' ? 'selected' : ''}>Disponible</option><option value="away" ${data.preferences.availability === 'away' ? 'selected' : ''}>Ausente</option></select><small>Disponible permite recibir reparto automático si tu marca lo tiene activo, estás conectado y tienes capacidad. Ausente detiene nuevas asignaciones automáticas.</small></label><label class="field">Firma rápida<textarea name="signature" maxlength="180" placeholder="Tu nombre · Equipo de atención">${esc(data.preferences.signature || '')}</textarea><small>La puedes insertar en el borrador antes de enviar.</small></label><button class="btn primary" type="submit">Guardar preferencias</button></form></section><section class="crm-panel"><h2>Acceso y seguridad</h2><p class="muted">Usuario: <strong>${esc(state.user.username)}</strong></p><p class="muted">Tu acceso: ${state.user.role === 'admin' ? 'Administración general' : 'Asesor de las marcas asignadas'}</p><div class="brand-pills">${state.brands.map(b => `<span class="pill">${esc(b.name)}</span>`).join('')}</div>${button('password', 'Cambiar contraseña')}${button('accept', 'Añadir una invitación')}<button class="btn" data-action="logout">${icon('log-out')}<span>Cerrar sesión</span></button><div id="sec-mfa" class="sec-mfa"></div><div id="push-panel" class="sec-mfa"></div><p class="crm-hint">Las invitaciones son personales. Administración puede ajustar tus marcas y revocar las sesiones.</p></section><section class="crm-panel settings-wide" aria-label="Respuestas rápidas"><div id="qr-panel"></div></section></div>`;
    } else if (view === 'team') content = '<div id="team-content" class="loading-message">Cargando accesos…</div>';
    $('#page').innerHTML =
      `<div class="content-page crm-page"><div class="page-heading"><div><span class="eyebrow">${esc(over)}</span><h1>${esc(title)}</h1><p>${esc(description)}</p></div><div class="actions">${add[view] || ''}</div></div><label class="crm-brand-filter">Marca<select id="crm-brand-picker"><option value="all">Todas mis marcas</option>${options(state.brands, 'id', 'name', state.brand)}</select></label>${content}</div>`;
    if (view === 'day') afterDay?.();
    if (view === 'team') renderTeam();
    if (view === 'settings') {
      securityUI.mount();
      pushUI.mount();
      quickUI.mount();
    }
    icons();
  }
  const searchBox = () =>
    `<form id="crm-search-form" class="crm-toolbar"><label class="search">${icon('search')}<input name="query" aria-label="Buscar en esta vista" value="${esc(query)}" placeholder="Buscar nombre, curso o responsable"></label><button class="btn" type="submit">Buscar</button></form>`;
  async function renderTeam() {
    try {
      const team = await api('/api/team');
      await securityUI.loadMembers();
      if (state.view !== 'team' || !$('#team-content')) return;
      $('#team-content').className = '';
      $('#team-content').innerHTML =
        `<section class="crm-panel"><div class="panel-title"><h2>Personas del equipo</h2>${button('recovery', 'Recuperar una cuenta')}</div>${team.members.map(m => `<div class="crm-list-row"><span class="avatar">${esc(m.name.slice(0, 2).toUpperCase())}</span><span class="grow"><strong>${esc(m.name)}</strong><small>@${esc(m.username)} · ${m.role === 'admin' ? 'Administración' : m.disabled ? 'Cuenta suspendida' : m.availability === 'away' ? 'Ausente' : 'Disponible'}</small><span class="brand-pills">${m.brandIds.map(id => `<span class="pill">${esc(brand(id))}</span>`).join('') || '<span class="pill">Sin marcas</span>'}</span></span>${securityUI.memberControls(m)}${m.role === 'agent' ? button('member', 'Gestionar', m.id) : '<span class="pill">Acceso general</span>'}</div>`).join('')}</section><section class="crm-panel"><div class="panel-title"><h2>Invitaciones individuales</h2></div>${
          team.invites
            .map(
              i =>
                `<div class="crm-list-row"><span class="grow"><strong>@${esc(i.username)}</strong><small>${JSON.parse(
                  i.brand_ids,
                )
                  .map(id => esc(brand(id)))
                  .join(
                    ' · ',
                  )} · Vence ${stamp(i.expires_at)}</small></span><span class="pill">${i.used_by ? 'Aceptada' : i.revoked_at ? 'Revocada' : i.expires_at < Date.now() ? 'Vencida' : 'Pendiente'}</span>${!i.used_by && !i.revoked_at && i.expires_at > Date.now() ? button('revoke', 'Revocar', i.id) : ''}</div>`,
            )
            .join('') ||
          blank('Invita a tu equipo', 'Cada código corresponde a un usuario, dura 24 horas y se usa una sola vez.')
        }</section>`;
      data.members = team.members;
      icons();
    } catch (e) {
      toast(e.message);
    }
  }
  function gate() {
    $('#page').innerHTML =
      `<div class="content-page crm-page"><div class="access-gate"><span class="gate-icon">${icon('users-round')}</span><span class="eyebrow">Acceso del equipo</span><h1>Tu cuenta ya está creada.</h1><p>Para entrar al CRM, acepta la invitación que administración preparó para <strong>@${esc(state.user.username)}</strong>. Conservarás tu perfil y tus conversaciones.</p><form id="crm-accept-form" class="form-grid">${field('Código de invitación individual', 'token', '', 'password', 'required autocomplete="off"')}<button type="submit" class="btn primary">Aceptar invitación y entrar</button></form><a class="text-link" href="/">Volver al laboratorio de cliente</a></div></div>`;
    icons();
  }
  function accept() {
    showModal(
      'Entrar al equipo',
      `<p>La invitación debe estar dirigida a <strong>@${esc(state.user.username)}</strong>. No necesitas otra cuenta.</p><form id="crm-accept-form" class="form-grid">${field('Código de invitación', 'token', '', 'password', 'required autocomplete="off"')}<button type="submit" class="btn primary">Aceptar invitación</button></form>`,
    );
  }
  async function showContact(id) {
    const detail = await api('/api/crm/contacts/' + id),
      c = detail.contact,
      opps = data.opportunities.filter(o => o.contact_id === id);
    showModal(
      c.name,
      `<span class="pill">${esc(brand(c.brand_id))}</span><p class="crm-hint">${esc(c.phone || 'Sin teléfono')} · ${esc(c.email || 'Sin correo')}</p>${personsUI.link(c)}${contactsUI.tagBlock(c)}<div class="actions">${button('edit-contact', 'Editar ficha', id)}${button('new-opportunity', 'Añadir interés', id)}</div><h3 class="modal-section-title">Sus oportunidades</h3>${opps.map(o => `<button class="crm-list-row" data-action="crm-opportunity" data-id="${o.id}"><span><strong>${esc(o.course_title)}</strong><small>${stageLabels[o.stage]}</small></span>${icon('arrow-up-right')}</button>`).join('') || '<p class="muted">Todavía no tiene oportunidades.</p>'}<h3 class="modal-section-title">Notas internas</h3><p class="crm-hint">Sólo el equipo con acceso a esta marca puede verlas. No se envían al cliente.</p><form id="crm-note-form" class="form-grid"><input name="contactId" type="hidden" value="${id}"><label class="field">Añadir nota<textarea name="text" maxlength="4000" required placeholder="Contexto para el siguiente seguimiento…"></textarea></label><button type="submit" class="btn">Guardar nota interna</button></form><div class="internal-notes">${detail.notes.map(n => `<article><p>${esc(n.text)}</p><small>${esc(n.author_name)} · ${stamp(n.created_at)}</small></article>`).join('')}</div>`,
    );
  }
  function editContact(id) {
    const c = data.contacts.find(c => c.id === id);
    showModal(
      c ? 'Editar contacto' : 'Nuevo contacto',
      `<form id="crm-contact-form" class="form-grid"><input name="id" type="hidden" value="${c?.id || ''}">${!c ? `<label class="field">Marca<select name="brandId" required>${options(state.brands, 'id', 'name', state.brand)}</select></label>` : ''}${field('Nombre', 'name', c?.name || '', 'text', 'required minlength="2" maxlength="100"')}${field('Teléfono (opcional)', 'phone', c?.phone || '', 'tel', 'maxlength="40"')}${field('Correo (opcional)', 'email', c?.email || '', 'email', 'maxlength="150"')}<button type="submit" class="btn primary">Guardar contacto</button></form>`,
    );
  }
  function newOpportunity(contactId) {
    const contacts = visible(data.contacts);
    if (!contacts.length) return toast('Primero crea un contacto en esta marca.');
    const c = contacts.find(c => c.id === contactId) || contacts[0];
    showModal(
      'Nueva oportunidad',
      `<p>Un interés en un curso, con responsable y siguiente paso.</p><form id="crm-opportunity-new-form" class="form-grid"><label class="field">Contacto<select name="contactId" id="crm-contact-select">${options(contacts, 'id', x => x.name + ' · ' + brand(x.brand_id), c.id)}</select></label><label class="field">Curso<select name="courseId" id="crm-course-select">${options(
        state.courses.filter(k => k.brand_id === c.brand_id),
        'id',
        'title',
      )}</select></label><label class="field">Edición<select name="editionId" id="crm-edition-select" required>${options(
        (state.editions || []).filter(e => e.course_id === state.courses.find(k => k.brand_id === c.brand_id)?.id),
        'id',
        'name',
      )}</select></label><label class="field">Responsable<select name="ownerId" id="crm-owner-select" required>${ownerOptions(c.brand_id, state.user.id)}</select></label>${field('Siguiente acción', 'nextAction', '', 'text', 'required maxlength="180" placeholder="Ej. Compartir temario y resolver dudas"')}${field('Fecha y hora de seguimiento', 'dueAt', future(), 'datetime-local', 'required')}<button type="submit" class="btn primary">Crear oportunidad y tarea</button></form>`,
    );
  }
  function offerSummary(raw) {
    if (!raw) return '';
    const o = JSON.parse(raw);
    return `<div class="cat-quote"><strong>Última información enviada: ${new Intl.NumberFormat('es-MX', { style: 'currency', currency: o.currency }).format(o.priceCents / 100)} ${esc(o.currency)}</strong><br>${esc(o.editionName)} · ${esc(o.dateLabel)}<small>Enviada ${stamp(o.sentAt)}${o.promotionEndsAt ? ' · Promoción ' + (o.promotionEndsAt <= Date.now() ? 'vencida' : 'hasta ' + stamp(o.promotionEndsAt)) : ''}. Conserva los datos del momento del envío.</small></div>`;
  }
  function showOpportunity(id) {
    const o = data.opportunities.find(o => o.id === id);
    if (!o) return toast('Actualiza la vista para encontrar esta oportunidad.');
    showModal(
      o.contact_name,
      `<span class="pill">${esc(brand(o.brand_id))}</span><h3 class="modal-section-title">${esc(o.course_title)}</h3><p class="crm-hint">${esc(o.edition_name || 'Edición general')}</p>${offerSummary(o.offer_snapshot)}<div class="actions">${button('contact', 'Ficha de contacto', o.contact_id)}${o.conversation_id ? button('chat', 'Abrir conversación', o.conversation_id) : ''}</div><form id="crm-opportunity-form" class="form-grid"><input type="hidden" name="id" value="${o.id}"><input type="hidden" name="expectedRevision" value="${o.revision}"><label class="field">Etapa<select name="stage">${Object.entries(
        stageLabels,
      )
        .map(([id, l]) => `<option value="${id}" ${o.stage === id ? 'selected' : ''}>${l}</option>`)
        .join(
          '',
        )}</select></label><label class="field">Responsable<select name="ownerId">${ownerOptions(o.brand_id, o.owner_id)}</select></label>${field('Motivo si no continuó', 'lostReason', o.lost_reason, 'text', 'maxlength="300"')}<button type="submit" class="btn primary">Guardar seguimiento</button></form><p class="crm-hint">Ganada es un resultado de práctica. No verifica un pago ni crea una inscripción real.</p><h3 class="modal-section-title">Próximas tareas</h3>${taskRows(data.tasks.filter(t => t.opportunity_id === id && t.status === 'open'))}<div class="actions">${button('new-task', 'Programar próxima tarea', id)}</div><div class="history-title"><h3 class="modal-section-title">Historial de seguimiento</h3>${button('opportunity', 'Recargar datos', id)}</div><div id="crm-history" data-opportunity="${id}" aria-live="polite">Cargando historial…</div>`,
    );
    loadHistory(id);
  }
  function newTask(oppId) {
    const opps = visible(data.opportunities).filter(o => !['ganada', 'perdida'].includes(o.stage));
    if (!opps.length) return toast('Primero crea una oportunidad activa.');
    showModal(
      'Programar seguimiento',
      `<form id="crm-task-form" class="form-grid"><label class="field">Oportunidad<select name="opportunityId">${options(opps, 'id', o => o.contact_name + ' · ' + o.course_title, oppId)}</select></label>${field('Qué hay que hacer', 'title', '', 'text', 'required maxlength="180" placeholder="Ej. Resolver dudas del horario"')}${field('Fecha y hora', 'dueAt', future(), 'datetime-local', 'required')}<p class="crm-hint">Se asignará al responsable de la oportunidad, o a ti si aún no tiene uno.</p><button type="submit" class="btn primary">Guardar tarea</button></form>`,
    );
  }
  function editTask(id) {
    const t = data.tasks.find(t => t.id === id);
    if (!t) return toast('Actualiza la vista para encontrar la tarea.');
    showModal(
      'Editar seguimiento',
      `<p class="crm-hint">${esc(t.contact_name)} · ${esc(t.course_title)}</p><form id="crm-task-edit-form" class="form-grid"><input type="hidden" name="id" value="${t.id}"><input type="hidden" name="expectedRevision" value="${t.revision}">${field('Qué hay que hacer', 'title', t.title, 'text', 'required maxlength="180"')}${field('Fecha y hora', 'dueAt', localDate(t.due_at), 'datetime-local', 'required')}<div class="actions"><button type="button" class="btn" data-action="crm-postpone" data-days="1">Mañana</button><button type="button" class="btn" data-action="crm-postpone" data-days="7">En una semana</button></div><label class="field">Responsable<select name="ownerId">${ownerOptions(t.brand_id, t.owner_id)}</select></label><label class="field">Estado<select name="status">${options(
        [
          { id: 'open', name: 'Pendiente' },
          { id: 'done', name: 'Completada' },
          { id: 'cancelled', name: 'Cancelada' },
        ],
        'id',
        'name',
        t.status,
      )}</select></label>${field('Motivo del cambio (opcional)', 'reason', '', 'text', 'maxlength="300"')}<p class="crm-hint">La fecha y hora se muestran en la zona de tu dispositivo. Los cambios quedan en el historial de la oportunidad.</p><div id="crm-edit-feedback" role="status"></div><div class="actions"><button type="submit" class="btn primary">Guardar tarea</button>${button('edit-task', 'Recargar datos', t.id)}${button('opportunity', 'Ver oportunidad e historial', t.opportunity_id)}</div></form>`,
    );
  }
  async function loadHistory(id, before = '') {
    const target = $('#crm-history');
    if (!target || target.dataset.opportunity !== id) return;
    try {
      const result = await api('/api/crm/opportunities/' + id + '/history' + (before ? '?before=' + before : ''));
      if ($('#crm-history') !== target) return;
      const status = { open: 'Pendiente', done: 'Completada', cancelled: 'Cancelada' };
      const detail = e => {
        const d = e.details;
        if (e.kind === 'offer')
          return (
            d.editionName +
            ' · ' +
            new Intl.NumberFormat('es-MX', { style: 'currency', currency: d.currency }).format(d.priceCents / 100) +
            ' ' +
            d.currency +
            ' · ' +
            d.dateLabel
          );
        if (e.kind === 'stage')
          return `${d.from ? stageLabels[d.from] + ' → ' : ''}${stageLabels[d.to]}${d.reason ? ' · ' + d.reason : ''}`;
        if (e.kind === 'owner') return `${d.from || 'Sin asignar'} → ${d.to || 'Sin asignar'}`;
        if (e.kind === 'reason') return d.to;
        if (e.kind.startsWith('task.')) {
          const n = d.next,
            p = d.previous,
            changes = [];
          if (!p || p.title !== n.title) changes.push(n.title);
          if (!p || p.dueAt !== n.dueAt) changes.push((p ? stamp(p.dueAt) + ' → ' : '') + stamp(n.dueAt));
          if (!p || p.status !== n.status) changes.push((p ? status[p.status] + ' → ' : '') + status[n.status]);
          if (p && p.ownerId !== n.ownerId)
            changes.push((p.ownerName || 'Sin asignar') + ' → ' + (n.ownerName || 'Sin asignar'));
          return [p?.title, ...changes, d.reason].filter(Boolean).join(' · ');
        }
        return '';
      };
      const titles = {
        offer: 'Información comercial enviada',
        stage: 'Etapa comercial',
        owner: 'Responsable',
        reason: 'Motivo de pérdida',
        'task.created': 'Tarea programada',
        'task.updated': 'Tarea actualizada',
      };
      if (!before) target.innerHTML = '';
      target.querySelector('.history-more')?.remove();
      target.insertAdjacentHTML(
        'beforeend',
        result.events
          .map(
            e =>
              `<article class="timeline-event"><span class="timeline-dot"></span><div><strong>${titles[e.kind] || 'Seguimiento'}</strong><p>${esc(detail(e))}</p><small>${esc(e.actor_name || (e.details.source === 'automation' ? 'Reglas automáticas' : 'Sistema'))} · ${stamp(e.created_at)}</small></div></article>`,
          )
          .join('') || (!before ? '<p class="crm-hint">Todavía no hay cambios registrados.</p>' : ''),
      );
      if (result.nextBefore)
        target.insertAdjacentHTML(
          'beforeend',
          `<button class="btn history-more" data-action="crm-history-more" data-id="${id}" data-before="${result.nextBefore}">Ver cambios anteriores</button>`,
        );
    } catch (e) {
      if ($('#crm-history') === target)
        target.innerHTML = `<p class="crm-hint">${esc(e.message)}</p>${button('opportunity', 'Volver a intentar', id)}`;
    }
  }
  function editFailure(error, id, task = false) {
    const target = $('#crm-edit-feedback') || $('#crm-opportunity-form');
    const old = $('#crm-conflict');
    old?.remove();
    if (target)
      target.insertAdjacentHTML(
        'beforeend',
        `<div id="crm-conflict" class="form-error" role="alert"><p>${esc(error.message)}</p>${error.activeOpportunityId ? button('opportunity', 'Abrir oportunidad activa', error.activeOpportunityId) : error.code === 'STALE_RECORD' ? button(task ? 'edit-task' : 'opportunity', 'Recargar datos', id) : ''}</div>`,
      );
    toast(error.message);
  }
  const checks = selected =>
    `<fieldset class="brand-checks"><legend>Marcas que podrá atender</legend>${state.brands.map(b => `<label><input type="checkbox" name="brandIds" value="${b.id}" ${selected.includes(b.id) ? 'checked' : ''}>${esc(b.name)}</label>`).join('')}</fieldset>`;
  async function action(name, el) {
    if (name.startsWith('sec-')) return securityUI.action(name, el);
    if (name.startsWith('push-')) return pushUI.action(name, el);
    if (name.startsWith('ctc-')) return contactsUI.action(name, el);
    if (name.startsWith('prs-')) return personsUI.action(name, el);
    if (!name.startsWith('crm-')) return false;
    const id = el?.dataset.id;
    if (name === 'crm-reload') await render();
    if (name === 'crm-contact') {
      await renderData();
      await showContact(id);
    }
    if (name === 'crm-new-contact') editContact();
    if (name === 'crm-edit-contact') editContact(id);
    if (name === 'crm-opportunity') {
      await renderData();
      showOpportunity(id);
    }
    if (name === 'crm-new-opportunity') {
      await renderData();
      newOpportunity(id);
    }
    if (name === 'crm-edit-task') {
      await renderData();
      editTask(id);
    }
    if (name === 'crm-postpone') {
      $('#crm-task-edit-form [name=dueAt]').value = localDate(Date.now() + Number(el.dataset.days) * 86400000);
    }
    if (name === 'crm-history-more') await loadHistory(id, el.dataset.before);
    if (name === 'crm-new-task') {
      await renderData();
      newTask(id);
    }
    if (name === 'crm-chat') {
      query = '';
      state.brand = 'all';
      state.channel = 'all';
      state.filter = 'all';
      state.query = '';
      state.mode = 'agent';
      setView('inbox');
      await selectConversation(id);
      $('#modal').close();
    }
    if (name === 'crm-task-filter') {
      state.taskFilter = id;
      draw();
    }
    if (name === 'crm-task-status') {
      await api('/api/crm/tasks/' + id, {
        method: 'PATCH',
        body: { status: el.dataset.status, expectedRevision: data.tasks.find(t => t.id === id)?.revision },
      });
      await renderData();
      if ($('#modal').open) {
        const t = data.tasks.find(t => t.id === id);
        showOpportunity(t.opportunity_id);
      } else draw();
      toast(el.dataset.status === 'done' ? 'Tarea completada' : 'Tarea reabierta');
    }
    if (name === 'crm-invite')
      showModal(
        'Invitar a un asesor',
        `<p>Indica su usuario actual o el que creará. La invitación no concede acceso de administrador.</p><form id="crm-invite-form" class="form-grid">${field('Usuario del compañero', 'username', '', 'text', 'required pattern="[a-zA-Z0-9_.\\-]{3,40}" autocapitalize="none"')}${checks([])}<button type="submit" class="btn primary">Crear invitación individual</button></form>`,
      );
    if (name === 'crm-revoke') {
      await api('/api/team/invites/' + id, { method: 'DELETE' });
      await renderTeam();
      toast('Invitación revocada');
    }
    if (name === 'crm-member') {
      const m = data.members.find(m => m.id === id);
      showModal(
        'Acceso de ' + m.name,
        `<form id="crm-member-form" class="form-grid"><input name="id" type="hidden" value="${id}">${checks(m.brandIds)}<label class="checkbox-field"><input name="disabled" type="checkbox" ${m.disabled ? 'checked' : ''}>Suspender el acceso</label><p class="crm-hint">Guardar cierra sus sesiones. El trabajo de marcas retiradas queda sin asignar para que puedas repartirlo.</p><button type="submit" class="btn primary">Guardar accesos</button></form>`,
      );
    }
    if (name === 'crm-accept') accept();
    if (name === 'crm-password')
      showModal(
        'Cambiar contraseña',
        `<form id="crm-password-form" class="form-grid">${field('Contraseña actual', 'currentPassword', '', 'password', 'required autocomplete="current-password"')}${field('Contraseña nueva', 'password', '', 'password', 'required minlength="10" maxlength="128" autocomplete="new-password"')}<p class="crm-hint">Se cerrarán tus sesiones para que vuelvas a entrar.</p><button type="submit" class="btn primary">Cambiar contraseña</button></form>`,
      );
    if (name === 'crm-recovery')
      showModal(
        'Recuperación asistida',
        `<p>Verifica la identidad de la persona por un medio conocido antes de entregarle el código. Sirve para asesores y participantes; no recupera administradores.</p><form id="crm-recovery-form" class="form-grid">${field('Usuario de la cuenta', 'username', '', 'text', 'required autocapitalize="none"')}<button type="submit" class="btn primary">Generar código de 30 minutos</button></form>`,
      );
    if (name === 'crm-recover-entry')
      showModal(
        'Recuperar mi cuenta',
        `<p>Pide a administración un código personal de recuperación. No necesitas crear otra cuenta.</p><form id="crm-recover-form" class="form-grid">${field('Usuario', 'username', '', 'text', 'required autocapitalize="none"')}${field('Código de recuperación', 'token', '', 'password', 'required autocomplete="off"')}${field('Contraseña nueva', 'password', '', 'password', 'required minlength="10" maxlength="128" autocomplete="new-password"')}<button type="submit" class="btn primary">Guardar contraseña nueva</button></form>`,
      );
    if (name === 'crm-insert-signature') {
      await renderData();
      const area = $('#message-input');
      if (!data.preferences.signature) return toast('Configura tu firma en Mi configuración.');
      if (area) {
        area.value += (area.value ? '\n\n' : '') + data.preferences.signature;
        area.dispatchEvent(new Event('input', { bubbles: true }));
        area.focus();
      }
    }
    return true;
  }
  async function renderData() {
    const [result, tagInfo] = await Promise.all([api('/api/crm'), api('/api/crm/tags')]);
    result.tagInfo = tagInfo;
    data = result;
  }
  async function submit(form, input) {
    if (form.getAttribute('id').startsWith('sec-')) return securityUI.submit(form, input);
    if (form.getAttribute('id').startsWith('ctc-')) return contactsUI.submit(form, input);
    if (form.getAttribute('id').startsWith('prs-')) return personsUI.submit(form, input);
    if (!form.getAttribute('id').startsWith('crm-')) return false;
    const id = form.getAttribute('id');
    if (id === 'crm-search-form') {
      query = input.query;
      draw();
      return true;
    }
    if (id === 'crm-accept-form') {
      await api('/api/team/accept', { method: 'POST', body: input });
      $('#modal').close();
      history.replaceState(null, '', '/crm');
      state.view = 'day';
      state.mode = 'agent';
      localStorage.setItem('tc-mode-' + state.user.id, 'agent');
      await load();
      toast('Tu acceso al equipo está listo');
      return true;
    }
    if (id === 'crm-recover-form') {
      await api('/api/auth/recover', { method: 'POST', body: input });
      $('#modal').close();
      state.authMode = 'login';
      entry();
      toast('Contraseña actualizada. Ya puedes entrar.');
      return true;
    }
    if (id === 'crm-password-form') {
      await api('/api/password', { method: 'POST', body: input });
      $('#modal').close();
      state.user = null;
      state.authMode = 'login';
      entry();
      toast('Contraseña actualizada. Inicia sesión de nuevo.');
      return true;
    }
    if (id === 'crm-invite-form' || id === 'crm-recovery-form') {
      const invite = id === 'crm-invite-form',
        result = await api(invite ? '/api/team/invites' : '/api/team/recovery', {
          method: 'POST',
          body: invite ? { ...input, brandIds: new FormData(form).getAll('brandIds') } : input,
        });
      showModal(
        invite ? 'Invitación lista' : 'Código de recuperación',
        `<p>Entrega este código sólo a <strong>@${esc(input.username.toLowerCase())}</strong>. Se muestra una sola vez y vence en ${invite ? '24 horas' : '30 minutos'}.</p>${field('Código personal', 'generatedToken', result.token, 'text', 'readonly spellcheck="false"')}<p class="crm-hint">${invite ? 'Entrar en ' + esc(location.origin) + '/crm con su cuenta y aceptar la invitación. Si no tiene cuenta, puede crearla con el usuario indicado.' : 'En la pantalla de entrada, elegir Recuperar mi cuenta e ingresar usuario, código y contraseña nueva.'}</p>`,
      );
      if (state.view === 'team') await renderTeam();
      return true;
    }
    if (id === 'crm-member-form')
      await api('/api/team/members/' + input.id, {
        method: 'PATCH',
        body: { brandIds: new FormData(form).getAll('brandIds'), disabled: input.disabled === 'on' },
      });
    if (id === 'crm-profile-form') {
      await api('/api/profile', { method: 'POST', body: input });
      state.user.name = input.name;
      await renderData();
      shell();
      toast('Preferencias guardadas');
      return true;
    }
    if (id === 'crm-contact-form')
      await api('/api/crm/contacts' + (input.id ? '/' + input.id : ''), {
        method: input.id ? 'PATCH' : 'POST',
        body: input,
      });
    if (id === 'crm-note-form') {
      await api('/api/crm/contacts/' + input.contactId + '/notes', { method: 'POST', body: { text: input.text } });
      await showContact(input.contactId);
      toast('Nota interna guardada');
      return true;
    }
    if (id === 'crm-opportunity-new-form')
      await api('/api/crm/opportunities', {
        method: 'POST',
        body: { ...input, dueAt: new Date(input.dueAt).getTime() },
      });
    if (id === 'crm-opportunity-form') {
      try {
        await api('/api/crm/opportunities/' + input.id, { method: 'PATCH', body: input });
      } catch (e) {
        editFailure(e, input.id);
        return true;
      }
    }
    if (id === 'crm-task-edit-form') {
      const original = data.tasks.find(t => t.id === input.id);
      const dueAt =
        original && localDate(original.due_at) === input.dueAt ? original.due_at : new Date(input.dueAt).getTime();
      try {
        await api('/api/crm/tasks/' + input.id, { method: 'PATCH', body: { ...input, dueAt } });
      } catch (e) {
        editFailure(e, input.id, true);
        return true;
      }
    }
    if (id === 'crm-task-form')
      await api('/api/crm/tasks', { method: 'POST', body: { ...input, dueAt: new Date(input.dueAt).getTime() } });
    $('#modal').close();
    await renderData();
    if (labels[state.view]) draw();
    await refresh();
    toast('Cambios guardados');
    return true;
  }
  function change(target) {
    if (target.id === 'ctc-tag-filter' || target.id === 'ctc-dup-brand') return contactsUI.change(target);
    if (target.id === 'crm-brand-picker') {
      state.brand = target.value;
      query = '';
      render();
      return true;
    }
    if (target.id === 'crm-course-select') {
      $('#crm-edition-select').innerHTML = options(
        (state.editions || []).filter(e => e.course_id === target.value),
        'id',
        'name',
      );
      return true;
    }
    if (target.id === 'crm-contact-select') {
      const c = data.contacts.find(c => c.id === target.value);
      $('#crm-course-select').innerHTML = options(
        state.courses.filter(k => k.brand_id === c.brand_id),
        'id',
        'title',
      );
      $('#crm-owner-select').innerHTML = ownerOptions(c.brand_id, state.user.id);
      $('#crm-edition-select').innerHTML = options(
        (state.editions || []).filter(e => e.course_id === $('#crm-course-select').value),
        'id',
        'name',
      );
      return true;
    }
    return false;
  }
  return {
    labels,
    nav,
    render,
    action,
    submit,
    change,
    gate,
    accept,
    contactForConversation: async id => {
      await renderData();
      const o = data.opportunities.find(o => o.conversation_ids?.split(',').includes(id));
      if (o) await showContact(o.contact_id);
      else toast('La ficha aparecerá al actualizar el seguimiento.');
    },
  };
};
