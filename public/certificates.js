// Certificación: pestaña Certificados de Operación (emitidos, verificaciones, ajustes y créditos por marca) y la sección
// de certificados dentro de la ficha de apertura (elegibilidad por inscrito, emisión y revocación).
window.createCertificatesUI = function ({ state, api, esc, icon, showModal, toast, refreshCoordination }) {
  const $ = s => document.querySelector(s),
    admin = () => state.user?.role === 'admin';
  const stamp = t =>
    t ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(t) : '—';
  const chip = (label, kind = '') => `<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const btn = (action, label, id = '', extra = '', klass = '') =>
    `<button type="button" class="btn ${klass}" data-action="cert-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const note = copy => `<p class="crm-hint">${copy}</p>`;
  const kpi = (label, value, sub = '') =>
    `<div class="an-kpi"><span>${label}</span><strong>${esc(String(value))}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  let data = null,
    images = [],
    query = '',
    status = '';
  async function load() {
    data = await api(
      '/api/certificates?' + new URLSearchParams({ brand: state.brand, q: query, ...(status ? { status } : {}) }),
    );
    if (admin()) {
      try {
        const cat = await api('/api/catalogue');
        images = (cat.flyers || [])
          .filter(f => /^image\//.test(f.mime || ''))
          .map(f => ({ id: f.file_id, brand_id: f.brand_id, name: f.filename || f.title }));
      } catch {
        images = [];
      }
    }
  }
  const certRow = c =>
    `<div class="co-row cert-row"><div><strong>${esc(c.folio)} · ${esc(c.holder_name)}</strong><small>${esc(c.course_title)} · ${esc(c.edition_name)} · ${esc(c.brand_name)}</small><small>${esc(c.issuedLabel)} · ${c.source === 'auto' ? 'emisión automática al cierre' : 'emisión manual'}${c.issued_by_name ? ' · ' + esc(c.issued_by_name) : ''} · asistencia ${c.attendance_pct} %${c.hours ? ' · ' + c.hours + ' h' : ''}</small>${c.status === 'revoked' ? `<small>Revocado ${stamp(c.revoked_at)}: ${esc(c.revoke_reason)}</small>` : ''}</div><div>${chip(c.statusLabel, c.status === 'issued' ? 'good' : 'urgent')}<small>${c.verifications} verificaciones</small></div><div class="actions">${btn('view', 'Ver', c.id, `data-url="${esc(c.svgUrl)}"`)}${btn('link', 'Enlace', c.id, `data-url="${esc(c.verifyUrl)}" data-folio="${esc(c.folio)}"`)}${c.status === 'issued' && admin() ? btn('revoke', 'Revocar', c.id) : ''}</div></div>`;
  function settingsPanel() {
    if (!admin() || !data.settings.length) return '';
    return `<details class="crm-panel co-details cert-settings"><summary>Emisión por marca · automática al cerrar, asistencia mínima, firma, logotipo y créditos</summary>${note('La emisión automática está apagada por omisión: con ella activa, al cerrar una apertura cada inscrito con la asistencia mínima recibe su certificado y el aviso por su chat. Lo manual (emitir o revocar desde la ficha de apertura) funciona siempre. El logotipo se toma de una imagen de la biblioteca de la marca (súbela como flyer o archivo).')}${data.settings
      .map(
        s =>
          `<form id="cert-settings-form-${esc(s.brand_id)}" class="form-grid cert-form"><input type="hidden" name="brandId" value="${esc(s.brand_id)}"><input type="hidden" name="expectedRevision" value="${s.revision}"><div class="ops-card-top"><strong>${esc(s.brand_name)}</strong>${s.credits_enabled ? chip(s.balance + ' créditos', s.balance > 0 ? 'good' : 'urgent') : chip('Sin créditos (ilimitado)')}</div><div class="co-inline"><label class="checkbox-field"><input type="checkbox" name="autoIssue" ${s.auto_issue ? 'checked' : ''}> Emitir al cerrar la apertura</label><label class="field">Asistencia mínima (%)<input name="minAttendancePct" type="number" min="0" max="100" value="${s.min_attendance_pct}"></label><label class="field">Color<input name="accent" type="color" value="${esc(s.accent)}"></label></div><div class="co-inline"><label class="field">Emisor<input name="issuerName" maxlength="120" value="${esc(s.issuer_name)}"></label><label class="field">Firma (nombre)<input name="signerName" maxlength="120" value="${esc(s.signer_name)}"></label><label class="field">Firma (cargo)<input name="signerTitle" maxlength="120" value="${esc(s.signer_title)}"></label></div><div class="co-inline"><label class="field">Logotipo (imagen de la biblioteca)<select name="logoFileId"><option value="">Sin logotipo</option>${images
            .filter(i => i.brand_id === s.brand_id)
            .map(
              i => `<option value="${esc(i.id)}" ${s.logo_file_id === i.id ? 'selected' : ''}>${esc(i.name)}</option>`,
            )
            .join(
              '',
            )}</select></label><label class="checkbox-field"><input type="checkbox" name="creditsEnabled" ${s.credits_enabled ? 'checked' : ''}> Usar créditos por consultora (cada emisión descuenta uno)</label><button class="btn" type="submit">Guardar</button></div></form><form id="cert-credits-form-${esc(s.brand_id)}" class="co-inline cert-credits"><input type="hidden" name="brandId" value="${esc(s.brand_id)}"><label class="field">Créditos (+/−)<input name="credits" type="number" min="-10000" max="10000" required placeholder="10"></label><label class="field">Motivo<input name="reason" maxlength="200" required placeholder="Compra de 10 créditos"></label><button class="btn" type="submit">Registrar créditos</button></form>`,
      )
      .join('')}</details>`;
  }
  function html() {
    if (!data) return '<div class="loading-message">Cargando…</div>';
    const st = data.stats;
    return `<div class="crm-toolbar"><p>Un solo emisor: folio secuencial IPCI-${st.year}-NNNNN, certificado SVG con código QR y verificación pública en <code class="cn-code">/verificar/&lt;folio&gt;</code> sin iniciar sesión. El alumno recibe el enlace por su chat.</p></div><div class="an-kpis">${kpi('Vigentes', st.issued)}${kpi('Revocados', st.revoked)}${kpi('Verificaciones públicas', st.verifications)}${kpi('Último folio del año', st.lastFolio ? 'IPCI-' + st.year + '-' + String(st.lastFolio).padStart(5, '0') : '—')}</div>${settingsPanel()}<form id="cert-search" class="co-filters"><label class="field">Buscar<input name="q" value="${esc(query)}" maxlength="80" placeholder="Folio, alumno o curso"></label><label class="field">Estado<select name="status"><option value="">Todos</option><option value="issued" ${status === 'issued' ? 'selected' : ''}>Vigentes</option><option value="revoked" ${status === 'revoked' ? 'selected' : ''}>Revocados</option></select></label><button class="btn" type="submit">Buscar</button></form><div class="co-list">${data.certificates.map(certRow).join('') || `<div class="crm-empty">${icon('award')}<h3>Sin certificados</h3><p>Se emiten desde la ficha de apertura (Coordinación) o solos al cerrarla, si la marca lo tiene activo.</p></div>`}</div>${note('Laboratorio: certificados de práctica sin validez oficial. La firma digital avanzada y los folios históricos de la Academia llegan después.')}`;
  }
  // Sección dentro de la ficha de apertura (Coordinación).
  function section(certs, d) {
    if (!certs) return '';
    const e = d.edition,
      rows = certs.enrollments.filter(r => r.status === 'enrolled');
    return `<section class="co-section"><h3>Certificados</h3><div class="co-meta"><span>Asistencia mínima ${certs.settings.min_attendance_pct} %</span><span>${certs.settings.auto_issue ? 'Emisión automática al cerrar' : 'Emisión manual'}</span>${certs.settings.credits_enabled ? `<span>${certs.settings.balance} créditos</span>` : ''}<span>${certs.issued} emitidos · ${certs.eligible} por emitir</span></div><div class="co-list">${rows.map(r => `<div class="co-row"><div><strong>${esc(r.contactName)}</strong><small>Asistencia ${r.pct} % (${r.attended} de ${r.held})</small>${r.certificate ? `<small>${esc(r.certificate.folio)} · ${esc(r.certificate.issuedLabel)}</small>` : r.reason ? `<small>${esc(r.reason)}</small>` : ''}</div><div>${r.certificate ? chip('Certificado', 'good') : r.eligible ? chip('Listo para emitir', 'good') : chip('No elegible')}</div><div class="actions">${r.certificate ? btn('view', 'Ver', r.certificate.id, `data-url="${esc(r.certificate.svgUrl)}"`) + btn('link', 'Enlace', r.certificate.id, `data-url="${esc(r.certificate.verifyUrl)}" data-folio="${esc(r.certificate.folio)}"`) + (certs.canIssue ? btn('revoke', 'Revocar', r.certificate.id) : '') : r.eligible && certs.canIssue ? btn('issue-one', 'Emitir', e.id, `data-enrollment="${esc(r.enrollmentId)}"`) : ''}</div></div>`).join('') || note('Sin inscritos activos.')}</div>${certs.canIssue && certs.eligible ? `<div class="actions">${btn('issue-all', 'Emitir los ' + certs.eligible + ' elegibles', e.id, '', 'primary')}</div>` : ''}${
      certs.certificates.some(c => c.status === 'revoked')
        ? `<details class="ctc-history"><summary>Revocados (${certs.certificates.filter(c => c.status === 'revoked').length})</summary>${certs.certificates
            .filter(c => c.status === 'revoked')
            .map(
              c =>
                `<div><b>${esc(c.folio)} · ${esc(c.holder_name)}</b><small>${stamp(c.revoked_at)} · ${esc(c.revoke_reason)}</small></div>`,
            )
            .join('')}</details>`
        : ''
    }</section>`;
  }
  const linkModal = (url, folio) =>
    showModal(
      'Enlace de verificación · ' + esc(folio),
      `<p class="crm-hint">Cualquiera puede abrir este enlace sin iniciar sesión; también está en el código QR del certificado.</p><p><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p><div class="actions">${btn('copy', 'Copiar enlace', '', `data-url="${esc(url)}"`)}<a class="btn" href="${esc(url)}.svg" target="_blank" rel="noopener">Abrir certificado</a></div>`,
    );
  async function action(name, el) {
    const id = el.dataset.id;
    try {
      if (name === 'cert-view') {
        window.open(el.dataset.url, '_blank', 'noopener');
        return true;
      }
      if (name === 'cert-link') {
        linkModal(el.dataset.url, el.dataset.folio);
        return true;
      }
      if (name === 'cert-copy') {
        try {
          await navigator.clipboard.writeText(el.dataset.url);
          toast('Enlace copiado.');
        } catch {
          toast('Copia el enlace manualmente.');
        }
        return true;
      }
      if (name === 'cert-issue-one' || name === 'cert-issue-all') {
        const r = await api('/api/certificates/editions/' + id + '/issue', {
          method: 'POST',
          body: name === 'cert-issue-one' ? { enrollmentIds: [el.dataset.enrollment] } : {},
        });
        toast(
          r.issued.length +
            (r.issued.length === 1 ? ' certificado emitido' : ' certificados emitidos') +
            (r.skipped.length ? ' · ' + r.skipped.length + ' sin emitir' : '') +
            '.',
        );
        await refreshCoordination();
        return 'reload';
      }
      if (name === 'cert-revoke') {
        showModal(
          'Revocar certificado',
          `<form id="cert-revoke-form" class="form-grid"><input type="hidden" name="id" value="${esc(id)}">${note('El folio queda visible como revocado en la verificación pública y la inscripción puede certificarse de nuevo con folio nuevo.')}<label class="field">Motivo<textarea name="reason" required minlength="5" maxlength="500" rows="3"></textarea></label><div class="actions"><button class="btn primary" type="submit">Revocar</button></div><div class="ops-feedback" role="status"></div></form>`,
        );
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
      if (id === 'cert-search') {
        query = input.q || '';
        status = input.status || '';
        return 'reload';
      }
      if (id?.startsWith('cert-settings-form-')) {
        const fd = new FormData(form);
        await api('/api/certificates/brands/' + input.brandId, {
          method: 'PATCH',
          body: {
            autoIssue: fd.has('autoIssue'),
            creditsEnabled: fd.has('creditsEnabled'),
            minAttendancePct: Number(input.minAttendancePct),
            issuerName: input.issuerName,
            signerName: input.signerName,
            signerTitle: input.signerTitle,
            accent: input.accent,
            logoFileId: input.logoFileId || null,
            expectedRevision: Number(input.expectedRevision),
          },
        });
        toast('Ajustes de certificación guardados.');
        return 'reload';
      }
      if (id?.startsWith('cert-credits-form-')) {
        const r = await api('/api/certificates/brands/' + input.brandId + '/credits', {
          method: 'POST',
          body: { credits: Number(input.credits), reason: input.reason },
        });
        toast('Saldo: ' + r.balance + ' créditos.');
        return 'reload';
      }
      if (id === 'cert-revoke-form') {
        await api('/api/certificates/' + input.id + '/revoke', { method: 'POST', body: { reason: input.reason } });
        $('#modal').close();
        toast('Certificado revocado.');
        await refreshCoordination();
        return 'reload';
      }
    } catch (e) {
      feedback(e.message);
      toast(e.message);
      return true;
    }
    return false;
  }
  return { load, html, section, action, submit };
};
