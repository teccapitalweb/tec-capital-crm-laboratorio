// Coordinación académica (pestaña Coordinación) y bitácora de eventos de dominio (pestaña Eventos) dentro de Operación.
window.createCoordinationUI = function ({ state, api, esc, icon, showModal, toast, openChat, certificates }) {
  const $ = s => document.querySelector(s),
    admin = () => state.user?.role === 'admin';
  const stamp = t =>
    t ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(t) : '—';
  const day = t => (t ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(t) : 'Sin fecha');
  const money = (c, cur) =>
    new Intl.NumberFormat('es-MX', { style: 'currency', currency: cur || 'MXN' }).format((c || 0) / 100);
  const local = t => {
    const d = new Date(t),
      p = n => String(n).padStart(2, '0');
    return (
      d.getFullYear() +
      '-' +
      p(d.getMonth() + 1) +
      '-' +
      p(d.getDate()) +
      'T' +
      p(d.getHours()) +
      ':' +
      p(d.getMinutes())
    );
  };
  const chip = (label, kind = '') => `<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const btn = (action, label, id = '', extra = '') =>
    `<button type="button" class="btn" data-action="co-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const note = copy => `<p class="crm-hint">${copy}</p>`;
  const brandName = id => state.brands.find(b => b.id === id)?.name || '';
  const KIND = { planned: '', open: 'good', running: 'good', closed: '', cancelled: 'urgent' };
  const MODALITY = { online: 'En línea', in_person: 'Presencial', hybrid: 'Híbrida' };
  const SURVEY_MODES = {
    off: 'Sin encuesta automática',
    session: 'Al realizar cada sesión',
    close: 'Al cerrar la apertura',
    both: 'Por sesión y al cerrar',
  };
  let data = null,
    statusFilter = 'all',
    detail = null,
    events = null,
    types = null,
    evFilter = { type: '', entity: '', q: '', entityId: '' };

  async function load(tab) {
    if (tab === 'coordination')
      data = await api(
        '/api/coordination?' +
          new URLSearchParams({ brand: state.brand, ...(statusFilter !== 'all' ? { status: statusFilter } : {}) }),
      );
    if (tab === 'events') {
      if (!types) types = await api('/api/events/types');
      events = await api(
        '/api/events?' +
          new URLSearchParams({
            brand: state.brand,
            ...Object.fromEntries(Object.entries(evFilter).filter(([, v]) => v)),
          }),
      );
    }
  }
  // ---- Coordinación
  const progress = e =>
    e.min_students > 0
      ? `<div class="co-progress ${e.enrolled >= e.min_students ? 'done' : ''}"><span style="width:${e.progress}%"></span></div><div class="co-meta"><span>${e.enrolled} de ${e.min_students} inscritos${e.missing ? ' · faltan ' + e.missing : ' · mínimo alcanzado'}</span>${e.available_seats !== null ? `<span>${e.available_seats} lugares libres</span>` : ''}</div>`
      : `<div class="co-meta"><span>${e.enrolled} inscritos · sin mínimo definido</span>${e.available_seats !== null ? `<span>${e.available_seats} lugares libres</span>` : ''}</div>`;
  function card(e) {
    return `<article class="crm-panel co-card"><div class="ops-card-top">${chip(e.runLabel, KIND[e.run_status])}${e.legacy ? chip('Edición general') : ''}${e.perSession ? chip(e.perSession + ' con plan por sesión') : ''}<small>${esc(brandName(e.brand_id))} · ${esc(e.name)}</small></div><h2>${esc(e.courseTitle)}</h2><p>${e.starts_at ? 'Inicia ' + day(e.starts_at) : 'Fecha por definir'} · ${MODALITY[e.modality] || e.modality} · ${e.coordinatorName ? 'Responsable: ' + esc(e.coordinatorName) : 'Sin responsable'}</p>${progress(e)}<p>${e.nextSession ? 'Próxima sesión: ' + esc(e.nextSession.title) + ' · ' + stamp(e.nextSession.starts_at) : e.sessions.scheduled + e.sessions.done ? e.sessions.done + ' sesiones realizadas' : 'Sin sesiones programadas'}</p><div class="actions">${btn('open', 'Abrir apertura', e.id)}</div></article>`;
  }
  function settingsPanel() {
    if (!admin() || !data.settings.length) return '';
    return `<details class="crm-panel co-settings co-details"><summary>Automatización por marca · abrir al llegar al mínimo y recordar sesiones</summary>${note('Apagada por omisión. Con ella activa, la apertura pasa a «abierta» sola cuando los pagos confirmados alcanzan el mínimo, y cada inscrito recibe por su chat un recordatorio de la sesión con la anticipación indicada; con «cobrar sesiones», el recordatorio lleva además el enlace de pago a quien tiene plan por sesión. La encuesta automática se envía al realizar cada sesión y/o al cerrar. Lo manual (sesiones, asistencia, recursos, estados, cobros y encuestas) funciona siempre.')}${data.settings
      .map(
        s =>
          `<form id="co-settings-form-${esc(s.brand_id)}" class="co-inline"><input type="hidden" name="brandId" value="${esc(s.brand_id)}"><input type="hidden" name="expectedRevision" value="${s.revision}"><strong>${esc(s.brand_name)}</strong><label class="checkbox-field"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> Automatización activa</label><label class="checkbox-field"><input type="checkbox" name="autoOpen" ${s.auto_open ? 'checked' : ''}> Abrir al llegar al mínimo</label><label class="field">Recordatorio (horas antes)<input name="reminderHours" type="number" min="1" max="168" value="${s.reminder_hours}"></label><label class="checkbox-field"><input type="checkbox" name="chargeSessions" ${s.charge_sessions ? 'checked' : ''}> Cobrar sesiones con el recordatorio</label><label class="field">Encuesta automática<select name="surveyMode">${Object.entries(
            SURVEY_MODES,
          )
            .map(([k, v]) => `<option value="${k}" ${s.survey_mode === k ? 'selected' : ''}>${esc(v)}</option>`)
            .join('')}</select></label><button class="btn" type="submit">Guardar</button></form>`,
      )
      .join('')}</details>`;
  }
  function coordinationHtml() {
    if (!data) return '<div class="loading-message">Cargando…</div>';
    const st = data.stats,
      filters = [
        ['all', 'Todas', st.planned + st.open + st.running + st.closed + st.cancelled],
        ['planned', 'Planeadas', st.planned],
        ['open', 'Abiertas', st.open],
        ['running', 'En curso', st.running],
        ['closed', 'Cerradas', st.closed],
      ];
    return `<div class="crm-toolbar"><p>Cada edición del catálogo es una apertura: mínimo de alumnos, inscritos que llegan solos con el pago confirmado, sesiones con enlace de videollamada, recordatorios, asistencia y cierre. ${st.enrolled} inscripciones activas · ${st.upcoming} sesiones por venir${st.sessionDue ? ' · ' + st.sessionDue + ' pagos de sesión pendientes' : ''}${st.surveyAnswers ? ' · ' + st.surveyAnswers + ' respuestas de encuesta' : ''}.</p></div><div class="ops-stats co-stats">${filters.map(([id, title, n]) => `<button type="button" data-action="co-filter" data-id="${id}" class="ops-stat ${statusFilter === id ? 'active' : ''}"><strong>${n}</strong><span>${title}</span></button>`).join('')}</div>${settingsPanel()}<div class="co-grid">${data.editions.map(card).join('') || `<div class="crm-empty">${icon('inbox')}<h3>Sin aperturas</h3><p>Publica una edición en Catálogo para coordinarla aquí.</p></div>`}</div>${note('La API real de Google Calendar/Meet y el envío por WhatsApp oficial entran por el contrato de conectores cuando lleguen los accesos; en el laboratorio el enlace de videollamada es simulado y los recordatorios van por el canal simulado.')}`;
  }
  function enrollmentRow(r) {
    const d = detail;
    return `<div class="co-row"><div><strong>${esc(r.contact_name)}</strong><small>${esc([r.phone, r.email].filter(Boolean).join(' · ') || 'Sin datos de contacto')}</small>${r.status === 'cancelled' ? `<small>Baja ${stamp(r.cancelled_at)}: ${esc(r.cancel_reason)}</small>` : ''}</div><div>${chip(r.status === 'enrolled' ? 'Inscrito' : 'Baja', r.status === 'enrolled' ? 'good' : '')}${r.payment_plan === 'per_session' ? ' ' + chip('Por sesión · ' + r.paidSessions + ' pagada' + (r.paidSessions === 1 ? '' : 's') + (r.pendingSessions ? ' · ' + r.pendingSessions + ' pendiente' + (r.pendingSessions === 1 ? '' : 's') : ''), r.pendingSessions ? 'high' : 'good') : ''} <small>${esc(r.reference)} · ${money(r.amount_cents, r.currency)} · ${r.paid_at ? 'pagado ' + stamp(r.paid_at) : ''}</small><small>Asistencia: ${r.attended} de ${r.held} sesiones realizadas</small></div><div class="actions">${r.conversation_id ? btn('chat', 'Chat', r.conversation_id) : ''}${r.status === 'enrolled' && d.canClose ? btn('enroll-cancel', 'Baja', r.id) : ''}</div></div>`;
  }
  function sessionRow(s) {
    const a = s.attendance,
      done = s.status === 'done';
    return `<div class="co-row"><div><strong>${s.number}. ${esc(s.title)}</strong><small>${stamp(s.starts_at)} · ${s.duration_min} min</small>${s.meet_url ? `<small><a href="${esc(s.meet_url)}" target="_blank" rel="noopener">${esc(s.meet_url)}</a>${s.meet_provider === 'simulated' ? ' · enlace simulado' : ''}</small>` : '<small>Sin enlace de videollamada</small>'}${s.recording_url ? `<small>Grabación: <a href="${esc(s.recording_url)}" target="_blank" rel="noopener">${esc(s.recording_url)}</a></small>` : ''}</div><div>${chip(s.statusLabel, s.status === 'done' ? 'good' : s.status === 'cancelled' ? 'urgent' : '')}${s.reminder_sent_at ? chip('Recordatorio enviado') : ''}<small>${a.present + a.late + a.absent + a.excused ? `Asistencia: ${a.present} presentes · ${a.late} retardos · ${a.absent} ausentes · ${a.excused} justificados` : 'Asistencia sin registrar'}</small></div><div class="actions">${s.status !== 'cancelled' ? btn('attendance', 'Asistencia', s.id) : ''}${s.status === 'scheduled' ? (s.meet_url ? '' : btn('meet', 'Enlace de videollamada', s.id)) + btn('session-edit', 'Editar', s.id) + btn('session-done', 'Realizada', s.id) + btn('session-cancel', 'Cancelar', s.id) : ''}</div></div>`;
  }
  function sessionPaymentsSection() {
    const d = detail,
      rows = d.enrollments.filter(r => r.payment_plan === 'per_session');
    if (!rows.length) return '';
    const label = p =>
      p.status === 'paid'
        ? 'Pagada'
        : p.status === 'waived'
          ? 'Condonada'
          : p.open_reference
            ? 'Enlace enviado'
            : 'Pendiente';
    return `<section class="co-section"><h3>Pagos por sesión</h3>${note('La inscripción por sesión cubre la primera sesión disponible; cada sesión siguiente se cobra con su propio pedido: con el recordatorio (si la marca lo activa) o aquí con «Cobrar». Condonar libera la sesión sin cobro; el reembolso de una sesión pagada se gestiona en Finanzas.' + (d.paymentsEnabled ? '' : ' La venta con pago está apagada para esta marca: no se pueden generar pedidos.'))}<div class="co-list">${rows
      .map(r => {
        const mine = d.sessionPayments.filter(p => p.enrollment_id === r.id);
        return `<div class="co-row co-sp"><div><strong>${esc(r.contact_name)}</strong><small>${esc(r.reference)} · plan por sesión</small></div><div class="co-sp-cells">${mine.map(p => `<span class="co-sp-cell ${p.status}">${p.session_number}. ${label(p)}${p.status === 'paid' && p.order_reference ? ' · ' + esc(p.order_reference) : ''}</span>`).join('') || '<small>Sin sesiones programadas</small>'}</div><div class="actions">${mine
          .filter(p => p.status === 'pending' && p.session_status === 'scheduled')
          .map(
            p =>
              btn(
                'charge',
                (p.open_reference ? 'Reenviar' : 'Cobrar') + ' sesión ' + p.session_number,
                p.session_id,
                `data-enrollment="${esc(r.id)}"`,
              ) +
              (d.canClose
                ? btn('waive', 'Condonar ' + p.session_number, p.session_id, `data-enrollment="${esc(r.id)}"`)
                : ''),
          )
          .join('')}</div></div>`;
      })
      .join('')}</div></section>`;
  }
  function surveysSection() {
    const d = detail,
      e = d.edition,
      pending = d.sessions.filter(s => s.status === 'done' && !d.surveys.some(v => v.session_id === s.id));
    return `<section class="co-section"><h3>Encuestas</h3>${note('Cada inscrito recibe por su chat un enlace propio y responde sin iniciar sesión: contenido, docente y organización (1 a 5), recomendación (0 a 10) y comentario. Automática por marca al realizar sesiones o al cerrar; manual desde aquí. Reenviar sólo alcanza a inscritos que aún no la tienen.')}<div class="co-list">${
      d.surveys
        .map(
          v =>
            `<div class="co-row co-survey"><div><strong>${esc(v.title)}</strong><small>${v.answered} de ${v.invited} respuestas · ${stamp(v.created_at)}${v.status === 'closed' ? ' · cerrada' : ''}</small>${
              v.comments.length
                ? `<ul class="co-comments">${v.comments
                    .slice(0, 5)
                    .map(c => `<li><strong>${esc(c.name)}</strong>: ${esc(c.comment)}</li>`)
                    .join('')}</ul>`
                : ''
            }</div><div>${v.answered ? `<div class="co-scores"><span>Contenido<strong>${v.averages.content}</strong></span><span>Docente<strong>${v.averages.instructor}</strong></span><span>Organización<strong>${v.averages.organization}</strong></span><span>NPS<strong>${v.nps.score}</strong></span></div>` : chip('Sin respuestas todavía')}</div><div class="actions"><a class="btn" href="/api/surveys/${esc(v.id)}.csv" download>${icon('download')} CSV</a>${v.status === 'open' ? btn('survey-send', 'Reenviar', e.id, `data-kind="${v.kind}" data-session="${esc(v.session_id || '')}"`) + btn('survey-close', 'Cerrar', v.id) : ''}</div></div>`,
        )
        .join('') || note('Todavía no se ha enviado ninguna encuesta.')
    }</div><div class="actions">${pending.map(s => btn('survey-send', 'Encuesta de la sesión ' + s.number, e.id, `data-kind="session" data-session="${esc(s.id)}"`)).join('')}${['running', 'closed'].includes(e.run_status) && !d.surveys.some(v => v.kind === 'edition') ? btn('survey-send', 'Encuesta de cierre', e.id, 'data-kind="edition"') : ''}</div></section>`;
  }
  function detailHtml() {
    const d = detail,
      e = d.edition,
      tz = e.timezone || '',
      tomorrow = local(
        Date.now() + 86400000 - ((Date.now() + 86400000) % 3600000) + 3600000 * (18 - new Date().getHours()),
      );
    const staffOpts =
      `<option value="">Sin responsable</option>` +
      d.staff
        .map(
          u =>
            `<option value="${u.id}" ${e.coordinator_id === u.id ? 'selected' : ''}>${esc(u.name)}${u.role === 'admin' ? ' · administración' : ''}</option>`,
        )
        .join('');
    const labels = {
      open: 'Confirmar apertura',
      running: 'Iniciar curso',
      closed: 'Cerrar apertura',
      cancelled: 'Cancelar apertura',
      planned: 'Volver a planeada',
    };
    const transitions = e.transitions
      .filter(t => !['closed', 'cancelled'].includes(t) || d.canClose)
      .map(t => btn('status', labels[t], e.id, `data-to="${t}" ${t === 'cancelled' ? '' : 'data-direct="1"'}`))
      .join('');
    return `<div class="ops-detail"><div class="ops-card-top">${chip(e.runLabel, KIND[e.run_status])}${chip(brandName(e.brand_id))}${chip(e.status === 'published' ? 'Publicada en catálogo' : e.status === 'draft' ? 'Borrador en catálogo' : 'Archivada')}</div><p>${esc(e.courseTitle)} · ${esc(e.name)} · ${e.starts_at ? day(e.starts_at) + (e.ends_at ? ' a ' + day(e.ends_at) : '') : 'fecha por definir'} · ${MODALITY[e.modality] || e.modality}${e.instructor ? ' · ' + esc(e.instructor) : ''}</p>${progress(e)}
      <div class="actions">${transitions}${note('Estados: planeada → abierta (al llegar al mínimo, sola si la automatización está activa) → en curso → cerrada. Cerrar o cancelar: administración o la persona responsable.')}</div>
      <form id="co-run-form" class="form-grid"><input type="hidden" name="editionId" value="${esc(e.id)}"><input type="hidden" name="expectedRevision" value="${e.run_revision}"><div class="co-inline"><label class="field">Mínimo de alumnos<input name="minStudents" type="number" min="0" max="500" value="${e.min_students}"></label><label class="field">Responsable<select name="coordinatorId" ${admin() || e.coordinator_id === state.user?.id ? '' : 'disabled'}>${staffOpts}</select></label></div><label class="field">Grupo de WhatsApp (enlace registrado, no creado)<input name="groupUrl" type="url" maxlength="500" value="${esc(e.group_url)}" placeholder="https://chat.whatsapp.com/…"></label><label class="field">Notas de coordinación<textarea name="note" rows="2" maxlength="1000">${esc(e.run_note)}</textarea></label><div class="actions"><button class="btn primary" type="submit">Guardar apertura</button></div></form>
      <section class="co-section"><h3>Inscritos (${d.enrollments.filter(r => r.status === 'enrolled').length})</h3><div class="co-list">${d.enrollments.map(enrollmentRow).join('') || note('Todavía no hay inscripciones. Llegan solas al confirmar un pago (Operación → Pagos).')}</div></section>
      <section class="co-section"><h3>Sesiones</h3><div class="co-list">${d.sessions.map(sessionRow).join('') || note('Sin sesiones. Programa la primera abajo.')}</div>${['closed', 'cancelled'].includes(e.run_status) ? '' : `<form id="co-session-form" class="form-grid"><input type="hidden" name="editionId" value="${esc(e.id)}"><div class="co-inline"><label class="field">Título<input name="title" maxlength="120" placeholder="Sesión ${d.sessions.length + 1}"></label><label class="field">Fecha y hora (${esc(tz)})<input name="startsAt" type="datetime-local" required value="${tomorrow}"></label><label class="field">Duración (min)<input name="durationMin" type="number" min="15" max="600" value="90"></label></div><label class="field">Enlace de videollamada (opcional)<input name="meetUrl" type="url" maxlength="500" placeholder="https://meet.google.com/…"></label><label class="checkbox-field"><input type="checkbox" name="createMeet" checked> Generar enlace con el calendario conectado (simulado en el laboratorio)</label><div class="actions"><button class="btn" type="submit">Programar sesión</button></div></form>`}</section>
      <section class="co-section"><h3>Materiales y grabaciones</h3><div class="co-list">${d.resources.map(r => `<div class="co-row"><div><strong>${esc(r.title)}</strong><small>${esc(r.kindLabel)}${r.session_id ? ' · sesión ' + (d.sessions.find(s => s.id === r.session_id)?.number || '') + '' : ''} · ${esc(r.created_by_name || '')} · ${stamp(r.created_at)}</small></div><div>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>` : ''}${r.fileUrl ? `<a href="${esc(r.fileUrl)}" target="_blank" rel="noopener">${esc(r.filename || 'Archivo')}</a>` : ''}</div><div class="actions">${btn('resource-delete', 'Quitar', r.id)}</div></div>`).join('') || note('Sin materiales. Añade enlaces (presentaciones, lecturas, grabaciones) o archivos de la biblioteca.')}</div><form id="co-resource-form" class="form-grid"><input type="hidden" name="editionId" value="${esc(e.id)}"><div class="co-inline"><label class="field">Tipo<select name="kind">${Object.entries(
        d.resourceKinds,
      )
        .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)
        .join(
          '',
        )}</select></label><label class="field">Título<input name="title" required maxlength="140"></label><label class="field">Sesión (opcional)<select name="sessionId"><option value="">Toda la apertura</option>${d.sessions.map(s => `<option value="${s.id}">${s.number}. ${esc(s.title)}</option>`).join('')}</select></label></div><label class="field">Enlace<input name="url" type="url" maxlength="500" placeholder="https://…"></label><div class="actions"><button class="btn" type="submit">Añadir recurso</button></div></form></section>
      ${sessionPaymentsSection()}${surveysSection()}
      ${certificates ? certificates.section(d.certs, d) : ''}
      <section class="co-section"><h3>Bitácora</h3><ul class="co-timeline">${d.events.map(ev => `<li><time>${stamp(ev.created_at)}</time><span><strong>${esc(types?.types.find(t => t.type === ev.type)?.title || ev.type)}</strong> · ${esc(payloadSummary(ev.payload))}${ev.actor_name ? ' · ' + esc(ev.actor_name) : ''}</span></li>`).join('') || '<li><span>Sin eventos todavía.</span></li>'}</ul></section><div class="ops-feedback" role="status"></div></div>`;
  }
  const loadCerts = async id => {
    try {
      return await api('/api/certificates/editions/' + id);
    } catch {
      return null;
    }
  };
  async function openDetail(id) {
    detail = await api('/api/coordination/editions/' + id);
    detail.certs = await loadCerts(id);
    if (!types && admin()) {
      try {
        types = await api('/api/events/types');
      } catch {}
    }
    showModal('Apertura · ' + esc(detail.edition.courseTitle), detailHtml());
  }
  async function refreshDetail() {
    if (!detail) return;
    const id = detail.edition.id;
    detail = await api('/api/coordination/editions/' + id);
    detail.certs = await loadCerts(id);
    const m = $('#modal');
    if (m?.open) {
      const box = m.querySelector('.ops-detail');
      if (box) box.outerHTML = detailHtml();
    }
  }
  function attendanceModal(s) {
    const rows = detail.enrollments.filter(r => r.status === 'enrolled');
    showModal(
      'Asistencia · ' + esc(s.title),
      `<form id="co-attendance-form" class="form-grid"><input type="hidden" name="sessionId" value="${esc(s.id)}">${note(stamp(s.starts_at) + ' · ' + s.duration_min + ' min. Marca a cada inscrito; se puede corregir después.')}${
        rows
          .map(r => {
            const cur = s.attendance.marks[r.id];
            return `<div class="co-att"><div><strong>${esc(r.contact_name)}</strong><small>${esc(r.reference)}</small></div><div class="co-radios">${Object.entries(
              detail.attendanceStatuses,
            )
              .map(
                ([k, v]) =>
                  `<label><input type="radio" name="a-${r.id}" value="${k}" ${cur?.status === k || (!cur && k === 'present') ? 'checked' : ''}> ${esc(v)}</label>`,
              )
              .join('')}</div></div>`;
          })
          .join('') || note('No hay inscritos activos.')
      }${rows.length ? '<div class="actions"><button class="btn primary" type="submit">Guardar asistencia</button></div>' : ''}<div class="ops-feedback" role="status"></div></form>`,
    );
  }
  function sessionEditModal(s) {
    showModal(
      'Editar sesión ' + s.number,
      `<form id="co-session-edit-form" class="form-grid"><input type="hidden" name="sessionId" value="${esc(s.id)}"><input type="hidden" name="expectedRevision" value="${s.revision}"><label class="field">Título<input name="title" maxlength="120" value="${esc(s.title)}"></label><div class="co-inline"><label class="field">Fecha y hora<input name="startsAt" type="datetime-local" required value="${local(s.starts_at)}"></label><label class="field">Duración (min)<input name="durationMin" type="number" min="15" max="600" value="${s.duration_min}"></label></div><label class="field">Enlace de videollamada<input name="meetUrl" type="url" maxlength="500" value="${esc(s.meet_url)}"></label><label class="field">Grabación<input name="recordingUrl" type="url" maxlength="500" value="${esc(s.recording_url)}"></label>${note('Si cambias la fecha, el recordatorio a los inscritos vuelve a programarse.')}<div class="actions"><button class="btn primary" type="submit">Guardar sesión</button></div><div class="ops-feedback" role="status"></div></form>`,
    );
  }
  const reasonModal = (id, title, formId, label, extra = '') =>
    showModal(
      title,
      `<form id="${formId}" class="form-grid"><input type="hidden" name="id" value="${esc(id)}">${extra}<label class="field">${label}<textarea name="reason" required minlength="5" maxlength="500" rows="3"></textarea></label><div class="actions"><button class="btn primary" type="submit">Confirmar</button></div><div class="ops-feedback" role="status"></div></form>`,
    );

  // ---- Eventos
  const payloadSummary = p =>
    Object.entries(p || {})
      .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
      .slice(0, 5)
      .map(([k, v]) => k + ': ' + (typeof v === 'number' && k.endsWith('At') ? stamp(v) : String(v).slice(0, 60)))
      .join(' · ');
  function eventRow(e) {
    const t = types?.types.find(x => x.type === e.type);
    return `<div class="co-event"><div><time>${stamp(e.created_at)}</time><div>${chip(e.brand_name)}</div></div><div><strong>${esc(t?.title || e.type)}</strong> <small>${esc(e.type)} · ${esc(types?.entities[e.entity_kind] || e.entity_kind)} ${esc(e.entity_id.slice(0, 8))} · ${esc(e.source)}${e.actor_name ? ' · ' + esc(e.actor_name) : ''}</small><div class="co-payload">${esc(payloadSummary(e.payload))}</div></div><div class="actions">${e.failed ? chip(e.failed + ' entregas fallidas', 'urgent') : e.pending ? chip(e.pending + ' pendientes', 'high') : e.subscribers ? chip(e.subscribers + ' entregadas', 'good') : ''}${btn('event', 'Detalle', String(e.seq))}</div></div>`;
  }
  function eventsHtml() {
    if (!events) return '<div class="loading-message">Cargando…</div>';
    const st = events.stats,
      csv =
        '/api/events.csv?' +
        new URLSearchParams({
          brand: state.brand,
          ...Object.fromEntries(Object.entries(evFilter).filter(([, v]) => v)),
        });
    return `<div class="crm-toolbar"><p>Índice común de hechos del negocio: cada módulo publica dentro de su transacción y los suscriptores reaccionan con reintento. Las tablas de cada módulo siguen siendo el detalle; aquí está la referencia.</p><a class="btn" href="${esc(csv)}" download>${icon('download')} CSV</a>${btn('events-reload', icon('refresh-cw') + ' Actualizar')}</div>
      <div class="ops-stats co-stats"><div class="ops-stat"><strong>${st.total}</strong><span>Eventos en total</span></div><div class="ops-stat"><strong>${st.last24h}</strong><span>Últimas 24 h</span></div><div class="ops-stat"><strong>${st.pending}</strong><span>Entregas pendientes</span></div><div class="ops-stat ${st.failed ? 'active' : ''}"><strong>${st.failed}</strong><span>Entregas fallidas</span></div></div>
      <form id="co-events-form" class="co-filters"><label class="field">Tipo<select name="type"><option value="">Todos</option>${(types?.types || []).map(t => `<option value="${t.type}" ${evFilter.type === t.type ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}</select></label><label class="field">Entidad<select name="entity"><option value="">Todas</option>${Object.entries(
        types?.entities || {},
      )
        .map(([k, v]) => `<option value="${k}" ${evFilter.entity === k ? 'selected' : ''}>${esc(v)}</option>`)
        .join(
          '',
        )}</select></label><label class="field">Id de entidad o pedido<input name="entityId" value="${esc(evFilter.entityId)}" placeholder="TC-…, id…"></label><label class="field">Buscar en la carga<input name="q" value="${esc(evFilter.q)}"></label><button class="btn" type="submit">Filtrar</button></form>
      <div class="co-events" id="co-events-list">${events.events.map(eventRow).join('') || `<div class="crm-empty">${icon('inbox')}<h3>Sin eventos</h3><p>Aparecen al abrir conversaciones, cambiar etapas, crear pedidos, confirmar pagos, entregar mensajes o coordinar aperturas.</p></div>`}</div>${events.nextBefore ? `<div class="ops-pagination">${btn('events-more', 'Ver anteriores', String(events.nextBefore))}</div>` : ''}
      <details class="crm-panel co-details"><summary>Catálogo de tipos (${(types?.types || []).length})</summary><ul class="co-timeline">${(types?.types || []).map(t => `<li><span><strong>${esc(t.type)}</strong></span><span>${esc(t.title)} · ${esc(types.entities[t.entity] || t.entity)} · carga: ${esc(t.payload)}${t.subscribers.length ? ' · suscriptores: ' + esc(t.subscribers.join(', ')) : ''}</span></li>`).join('')}</ul></details>${note(
        'Por tipo: ' +
          Object.values(st.byType || [])
            .slice(0, 8)
            .map(r => esc(r.type) + ' ' + r.n)
            .join(' · '),
      )}`;
  }
  async function eventModal(seq) {
    const r = await api('/api/events/' + seq),
      e = r.event,
      t = types?.types.find(x => x.type === e.type);
    showModal(
      (t?.title || e.type) + ' · #' + e.seq,
      `<div class="ops-card-top">${chip(e.brand_name || brandName(e.brand_id))}${chip(e.entity_kind + ' ' + e.entity_id)}<small>${stamp(e.created_at)} · ${esc(e.source)}${e.actor_name ? ' · ' + esc(e.actor_name) : ''}</small></div><h3>Carga</h3><pre class="cat-preview-copy">${esc(JSON.stringify(e.payload, null, 2))}</pre><h3>Entregas a suscriptores</h3><div class="co-deliveries" data-seq="${e.seq}">${r.deliveries.map(d => `<div>${chip(d.subscriber)}${chip({ pending: 'Pendiente', done: 'Entregada', failed: 'Fallida' }[d.state], d.state === 'done' ? 'good' : d.state === 'failed' ? 'urgent' : 'high')}<small>${d.attempts} intentos${d.error ? ' · ' + esc(d.error) : ''}${d.state === 'pending' ? ' · próximo ' + stamp(d.next_attempt_at) : ''}</small>${d.state === 'failed' ? btn('event-retry', 'Reintentar', String(e.seq), `data-subscriber="${esc(d.subscriber)}"`) : ''}</div>`).join('') || note('Este tipo no tiene suscriptores en proceso; queda sólo como registro.')}</div><p class="crm-hint">Clave de idempotencia: <code class="cn-code">${esc(e.dedupe_key)}</code></p>`,
    );
  }

  function html(tab) {
    return tab === 'events' ? eventsHtml() : coordinationHtml();
  }
  async function action(name, el) {
    const id = el.dataset.id;
    try {
      if (name === 'co-filter') {
        statusFilter = id;
        return 'reload';
      }
      if (name === 'co-open') {
        await openDetail(id);
        return true;
      }
      if (name === 'co-chat') {
        await openChat(id);
        return true;
      }
      if (name === 'co-status') {
        const to = el.dataset.to;
        if (to === 'cancelled') {
          reasonModal(
            id,
            'Cancelar apertura',
            'co-status-form',
            'Motivo (se registra en la bitácora; los inscritos no reciben mensaje automático)',
            `<input type="hidden" name="to" value="cancelled"><input type="hidden" name="expectedRevision" value="${detail.edition.run_revision}">`,
          );
          return true;
        }
        await api('/api/coordination/editions/' + id + '/status', {
          method: 'POST',
          body: { to, expectedRevision: detail.edition.run_revision },
        });
        toast('Apertura actualizada.');
        await refreshDetail();
        return 'reload';
      }
      if (name === 'co-enroll-cancel') {
        reasonModal(
          id,
          'Baja de la inscripción',
          'co-enroll-cancel-form',
          'Motivo de la baja (el cupo se libera; el reembolso se gestiona en Pagos/Finanzas)',
        );
        return true;
      }
      if (name === 'co-attendance') {
        attendanceModal(detail.sessions.find(s => s.id === id));
        return true;
      }
      if (name === 'co-meet') {
        await api('/api/coordination/sessions/' + id + '/meet', { method: 'POST', body: {} });
        toast('Enlace de videollamada generado (simulado).');
        await refreshDetail();
        return true;
      }
      if (name === 'co-session-edit') {
        sessionEditModal(detail.sessions.find(s => s.id === id));
        return true;
      }
      if (name === 'co-session-done') {
        await api('/api/coordination/sessions/' + id + '/done', { method: 'POST', body: {} });
        toast('Sesión marcada como realizada.');
        await refreshDetail();
        return 'reload';
      }
      if (name === 'co-session-cancel') {
        reasonModal(id, 'Cancelar sesión', 'co-session-cancel-form', 'Motivo');
        return true;
      }
      if (name === 'co-charge') {
        const r = await api('/api/coordination/sessions/' + id + '/charge', {
          method: 'POST',
          body: { enrollmentId: el.dataset.enrollment },
        });
        toast(
          r.created
            ? 'Pedido ' + r.order.reference + ' creado y enlace enviado por el chat.'
            : 'Enlace del pedido ' + r.order.reference + ' reenviado.',
        );
        await refreshDetail();
        return true;
      }
      if (name === 'co-waive') {
        reasonModal(
          id,
          'Condonar sesión',
          'co-waive-form',
          'Motivo (queda en la bitácora; si hay un pedido vigente se cancela)',
          `<input type="hidden" name="enrollmentId" value="${esc(el.dataset.enrollment)}">`,
        );
        return true;
      }
      if (name === 'co-survey-send') {
        const r = await api('/api/coordination/editions/' + id + '/surveys', {
          method: 'POST',
          body: { kind: el.dataset.kind, sessionId: el.dataset.session || null },
        });
        toast(
          r.sent
            ? 'Encuesta enviada a ' +
                r.sent +
                ' inscrito' +
                (r.sent === 1 ? '' : 's') +
                (r.skipped ? ' · ' + r.skipped + ' sin invitación' : '') +
                '.'
            : 'No había inscritos nuevos por invitar.',
        );
        await refreshDetail();
        return 'reload';
      }
      if (name === 'co-survey-close') {
        await api('/api/surveys/' + id + '/close', { method: 'POST', body: {} });
        toast('Encuesta cerrada.');
        await refreshDetail();
        return true;
      }
      if (name === 'co-resource-delete') {
        await api('/api/coordination/resources/' + id, { method: 'DELETE' });
        toast('Recurso quitado.');
        await refreshDetail();
        return true;
      }
      if (name === 'co-events-reload') return 'reload';
      if (name === 'co-events-more') {
        const r = await api(
          '/api/events?' +
            new URLSearchParams({
              brand: state.brand,
              before: id,
              ...Object.fromEntries(Object.entries(evFilter).filter(([, v]) => v)),
            }),
        );
        events.events.push(...r.events);
        events.nextBefore = r.nextBefore;
        const list = $('#co-events-list');
        if (list) {
          list.insertAdjacentHTML('beforeend', r.events.map(eventRow).join(''));
          el.closest('.ops-pagination')?.remove();
          if (r.nextBefore)
            list.insertAdjacentHTML(
              'afterend',
              `<div class="ops-pagination">${btn('events-more', 'Ver anteriores', String(r.nextBefore))}</div>`,
            );
        }
        return true;
      }
      if (name === 'co-event') {
        await eventModal(id);
        return true;
      }
      if (name === 'co-event-retry') {
        await api('/api/events/' + id + '/retry', { method: 'POST', body: { subscriber: el.dataset.subscriber } });
        toast('Entrega reprogramada.');
        await eventModal(id);
        return true;
      }
    } catch (e) {
      toast(e.message);
      return true;
    }
    return false;
  }
  async function submit(form, input) {
    const id = form.getAttribute('id'),
      feedback = msg => {
        const f = form.querySelector('.ops-feedback');
        if (f) f.textContent = msg;
      };
    try {
      if (id?.startsWith('co-settings-form-')) {
        await api('/api/coordination/brands/' + input.brandId, {
          method: 'PATCH',
          body: {
            enabled: new FormData(form).has('enabled'),
            autoOpen: new FormData(form).has('autoOpen'),
            chargeSessions: new FormData(form).has('chargeSessions'),
            surveyMode: input.surveyMode,
            reminderHours: Number(input.reminderHours),
            expectedRevision: Number(input.expectedRevision),
          },
        });
        toast('Automatización de coordinación guardada.');
        return 'reload';
      }
      if (id === 'co-run-form') {
        await api('/api/coordination/editions/' + input.editionId, {
          method: 'PATCH',
          body: {
            minStudents: Number(input.minStudents),
            ...(form.querySelector('[name=coordinatorId]').disabled
              ? {}
              : { coordinatorId: input.coordinatorId || null }),
            groupUrl: input.groupUrl,
            note: input.note,
            expectedRevision: Number(input.expectedRevision),
          },
        });
        toast('Apertura guardada.');
        await refreshDetail();
        return 'reload';
      }
      if (id === 'co-status-form') {
        await api('/api/coordination/editions/' + input.id + '/status', {
          method: 'POST',
          body: { to: input.to, reason: input.reason, expectedRevision: Number(input.expectedRevision) },
        });
        toast('Apertura cancelada.');
        detail = null;
        $('#modal').close();
        return 'reload';
      }
      if (id === 'co-session-form') {
        await api('/api/coordination/editions/' + input.editionId + '/sessions', {
          method: 'POST',
          body: {
            title: input.title,
            startsAt: new Date(input.startsAt).getTime(),
            durationMin: Number(input.durationMin),
            meetUrl: input.meetUrl,
            createMeet: new FormData(form).has('createMeet'),
          },
        });
        toast('Sesión programada.');
        await refreshDetail();
        return 'reload';
      }
      if (id === 'co-session-edit-form') {
        await api('/api/coordination/sessions/' + input.sessionId, {
          method: 'PATCH',
          body: {
            title: input.title,
            startsAt: new Date(input.startsAt).getTime(),
            durationMin: Number(input.durationMin),
            meetUrl: input.meetUrl,
            recordingUrl: input.recordingUrl,
            expectedRevision: Number(input.expectedRevision),
          },
        });
        toast('Sesión guardada.');
        await openDetail(detail.edition.id);
        return 'reload';
      }
      if (id === 'co-session-cancel-form') {
        await api('/api/coordination/sessions/' + input.id + '/cancel', {
          method: 'POST',
          body: { reason: input.reason },
        });
        toast('Sesión cancelada.');
        await openDetail(detail.edition.id);
        return 'reload';
      }
      if (id === 'co-attendance-form') {
        const marks = detail.enrollments
          .filter(r => r.status === 'enrolled')
          .map(r => ({ enrollmentId: r.id, status: input['a-' + r.id] || 'present' }));
        await api('/api/coordination/sessions/' + input.sessionId + '/attendance', { method: 'PUT', body: { marks } });
        toast('Asistencia guardada.');
        await openDetail(detail.edition.id);
        return 'reload';
      }
      if (id === 'co-resource-form') {
        await api('/api/coordination/editions/' + input.editionId + '/resources', {
          method: 'POST',
          body: { kind: input.kind, title: input.title, url: input.url, sessionId: input.sessionId || null },
        });
        toast('Recurso añadido.');
        await refreshDetail();
        return true;
      }
      if (id === 'co-waive-form') {
        await api('/api/coordination/sessions/' + input.id + '/waive', {
          method: 'POST',
          body: { enrollmentId: input.enrollmentId, note: input.reason },
        });
        toast('Sesión condonada.');
        await openDetail(detail.edition.id);
        return 'reload';
      }
      if (id === 'co-enroll-cancel-form') {
        await api('/api/coordination/enrollments/' + input.id + '/cancel', {
          method: 'POST',
          body: { reason: input.reason },
        });
        toast('Baja registrada.');
        await openDetail(detail.edition.id);
        return 'reload';
      }
      if (id === 'co-events-form') {
        evFilter = { type: input.type, entity: input.entity, q: input.q, entityId: input.entityId };
        return 'reload';
      }
    } catch (e) {
      feedback(e.message);
      toast(e.message);
      return true;
    }
    return false;
  }
  return { load, html, action, submit, refreshDetail };
};
