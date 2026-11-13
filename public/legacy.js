// Históricos del IPCIL (pestaña de Operación, administración): importar JSON/CSV del panel actual, vista previa, lotes.
window.createLegacyUI = function ({ state, api, esc, icon, showModal, toast }) {
  const $ = s => document.querySelector(s);
  const stamp = t =>
    t ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(t) : '—';
  const day = t => (t ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(t) : 'sin fecha');
  const money = c => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format((c || 0) / 100);
  const chip = (label, kind = '') => `<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const btn = (action, label, id = '', extra = '', klass = '') =>
    `<button type="button" class="btn ${klass}" data-action="leg-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const note = copy => `<p class="crm-hint">${copy}</p>`;
  let data = null,
    format = null,
    preview = null,
    draft = { brandId: '', format: 'json', kind: 'alumno', content: '', filename: '', note: '' };
  async function load() {
    data = await api('/api/legacy?brand=' + encodeURIComponent(state.brand));
    if (!format) format = await api('/api/legacy/format');
    if (!draft.brandId) draft.brandId = state.brand !== 'all' ? state.brand : state.brands[0]?.id || '';
  }
  function keep() {
    const f = $('#leg-form');
    if (!f) return;
    const fd = new FormData(f);
    draft = {
      brandId: fd.get('brandId') || draft.brandId,
      format: fd.get('format') || 'json',
      kind: fd.get('kind') || 'alumno',
      content: fd.get('content') || '',
      filename: draft.filename,
      note: fd.get('note') || '',
    };
  }
  function counts(c) {
    return Object.entries(c)
      .map(
        ([k, v]) =>
          `<div class="ops-stat ${v.invalid ? 'active' : ''}"><strong>${v.new}</strong><span>${esc(data.kinds[k])}<br><small>${v.existing ? v.existing + ' ya importados · ' : ''}${v.invalid ? v.invalid + ' con error' : 'sin errores'}</small></span></div>`,
      )
      .join('');
  }
  function importBox() {
    return `<section class="crm-panel leg-page"><div class="ops-card-top"><h2>Importar históricos del panel IPCIL</h2>${chip('Sólo lectura · sin comisiones')}</div>${note('Exporta del panel actual (Firebase) un JSON con las listas <code class="cn-code">cursos</code>, <code class="cn-code">aperturas</code>, <code class="cn-code">alumnos</code> (con sus <code class="cn-code">pagos</code>), <code class="cn-code">ventas</code> y <code class="cn-code">certificados</code>, o un CSV por tipo con los mismos nombres de campo. Cada alumno queda ligado a una persona del CRM por teléfono o correo (se crea su contacto en la marca si no existe); las ventas y certificados se ven en su ficha y en Finanzas como históricos. Repetir un archivo no duplica: se reconoce por marca, tipo e id.')}
      <form id="leg-form" class="form-grid"><div class="cat-form-columns"><label class="field">Marca destino<select name="brandId">${state.brands.map(b => `<option value="${esc(b.id)}" ${draft.brandId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label><label class="field">Formato<select name="format"><option value="json" ${draft.format === 'json' ? 'selected' : ''}>JSON (documento completo o lista)</option><option value="csv" ${draft.format === 'csv' ? 'selected' : ''}>CSV (un tipo por archivo)</option></select></label><label class="field">Tipo (CSV o lista JSON)<select name="kind">${Object.entries(
        format?.kinds || {},
      )
        .map(([k, v]) => `<option value="${k}" ${draft.kind === k ? 'selected' : ''}>${esc(v)}</option>`)
        .join('')}</select></label></div>
      <label class="field">Archivo<input type="file" id="leg-file" accept=".json,.csv,text/csv,application/json"></label><div class="actions">${btn('read', 'Leer archivo')}<small class="crm-hint">${draft.filename ? 'Archivo: ' + esc(draft.filename) : 'o pega el contenido abajo'}</small></div>
      <label class="field">Contenido<textarea name="content" rows="8" spellcheck="false" placeholder='{"alumnos":[{"nombre":"Ana Pérez","telefono":"5512345678","cursoId":"c1","pagos":[{"fecha":"2025-02-20","monto":2250}]}]}'>${esc(draft.content)}</textarea></label>
      <label class="field">Nota del lote (opcional)<input name="note" maxlength="300" value="${esc(draft.note)}" placeholder="Exportación del panel, noviembre 2026"></label>
      <div class="actions"><button class="btn" type="submit">${icon('search')} Vista previa</button>${preview && !preview.errorCount && Object.values(preview.counts).some(c => c.new) ? btn('apply', icon('download') + ' Importar ' + Object.values(preview.counts).reduce((n, c) => n + c.new, 0) + ' registros', '', '', 'primary') : preview && preview.errorCount ? btn('apply', 'Importar sólo los válidos', '', '', 'primary') : ''}</div><div class="ops-feedback" role="status"></div></form>
      ${
        preview
          ? `<div class="leg-preview"><h3>Vista previa · ${esc(preview.brand.name)}</h3><div class="ops-stats co-stats">${counts(preview.counts)}</div>${preview.errorCount ? `<details class="crm-panel co-details" open><summary>${preview.errorCount} fila(s) con error (no se importan)</summary><ul class="cn-list">${preview.errors.map(e => `<li>${esc(data.kinds[e.kind] || e.kind)} · fila ${e.row}: ${esc(e.message)}</li>`).join('')}</ul></details>` : ''}${Object.entries(
              preview.sample,
            )
              .filter(([, v]) => v.length)
              .map(
                ([k, v]) =>
                  `<details class="crm-panel co-details"><summary>Muestra · ${esc(data.kinds[k])}</summary><ul class="cn-list">${v.map(r => `<li><strong>${esc(r.title)}</strong> · ${esc(r.external_id)}${r.amount_cents !== null && r.amount_cents !== undefined ? ' · ' + money(r.amount_cents) : ''}${r.occurred_at ? ' · ' + day(r.occurred_at) : ''}${r.status ? ' · ' + esc(r.status) : ''}</li>`).join('')}</ul></details>`,
              )
              .join('')}</div>`
          : ''
      }
      <details class="crm-panel co-details"><summary>Formato: campos por tipo y ejemplo</summary><table class="leg-table"><thead><tr><th>Tipo</th><th>Obligatorios</th><th>Opcionales</th></tr></thead><tbody>${Object.entries(
        format?.fields || {},
      )
        .map(
          ([k, f]) =>
            `<tr><td>${esc(format.kinds[k])}</td><td>${f.required.map(x => `<code>${esc(x)}</code>`).join(' ')}</td><td>${f.optional.map(x => `<code>${esc(x)}</code>`).join(' ')}</td></tr>`,
        )
        .join(
          '',
        )}</tbody></table>${note('Fechas: ISO (2025-02-20), DD/MM/AAAA, milisegundos o {seconds} de Firestore. Importes en pesos. Los folios IPCI-AAAA-NNNNN importados adelantan la secuencia del año para que el CRM no los repita.')}<pre class="cat-preview-copy">${esc(JSON.stringify(format?.example || {}, null, 2))}</pre></details></section>`;
  }
  function batches() {
    const t = data.totals;
    return `<section class="crm-panel"><div class="ops-card-top"><h2>Históricos importados</h2>${btn('reload', icon('refresh-cw') + ' Actualizar')}</div><div class="ops-stats co-stats">${Object.entries(
      t,
    )
      .map(
        ([k, v]) =>
          `<div class="ops-stat"><strong>${v.n}</strong><span>${esc(data.kinds[k])}${k === 'venta' ? '<br><small>' + money(v.cents) + '</small>' : k === 'alumno' ? '<br><small>' + v.persons + ' personas</small>' : ''}</span></div>`,
      )
      .join('')}</div><div class="co-list">${
      data.batches
        .map(
          b =>
            `<div class="co-row"><div><strong>${esc(b.brand_name)} · ${esc(b.filename || 'contenido pegado')}</strong><small>${stamp(b.imported_at)} · ${esc(b.imported_by_name || '')} · ${esc(b.format)}${b.note ? ' · ' + esc(b.note) : ''}</small></div><div><small>${
              ['curso', 'apertura', 'alumno', 'venta', 'certificado']
                .map(k => (b.counts[k] ? b.counts[k] + ' ' + k + (b.counts[k] === 1 ? '' : 's') : ''))
                .filter(Boolean)
                .join(' · ') || 'sin registros'
            }${b.counts.repeated ? ' · ' + b.counts.repeated + ' repetidos' : ''}${b.counts.personsCreated ? ' · ' + b.counts.personsCreated + ' personas nuevas' : ''}${b.counts.personsLinked ? ' · ' + b.counts.personsLinked + ' ya existentes' : ''}${b.counts.unlinked ? ' · ' + b.counts.unlinked + ' sin alumno' : ''}</small></div><div class="actions">${btn('remove', 'Quitar lote', b.id)}</div></div>`,
        )
        .join('') || note('Todavía no se ha importado ningún histórico.')
    }</div>${note('Quitar un lote borra sus registros históricos; las personas y contactos creados se conservan porque son datos de la empresa.')}</section>`;
  }
  function html() {
    if (!data) return '<div class="loading-message">Cargando…</div>';
    return `<div class="crm-toolbar"><p>Puente con el IPCIL actual mientras llega el nuevo: históricos de alumnos, aperturas, ventas y certificados ligados a la persona única del CRM. Sin adaptadores en vivo a Firestore.</p></div>${importBox()}${batches()}`;
  }
  async function action(name, el) {
    try {
      if (name === 'leg-reload') return 'reload';
      if (name === 'leg-read') {
        const f = $('#leg-file')?.files?.[0];
        if (!f) {
          toast('Elige un archivo primero.');
          return true;
        }
        if (f.size > 5 * 1024 * 1024) {
          toast('El archivo supera 5 MB: divídelo.');
          return true;
        }
        const txt = await f.text();
        keep();
        draft.content = txt;
        draft.filename = f.name;
        if (/\.csv$/i.test(f.name)) draft.format = 'csv';
        if (/\.json$/i.test(f.name)) draft.format = 'json';
        preview = null;
        return 'reload';
      }
      if (name === 'leg-apply') {
        keep();
        if (!preview) {
          toast('Primero genera la vista previa.');
          return true;
        }
        const r = await api('/api/legacy/apply', { method: 'POST', body: { ...draft } });
        toast(
          'Importados: ' +
            ['curso', 'apertura', 'alumno', 'venta', 'certificado']
              .map(k => r.counts[k] + ' ' + k + (r.counts[k] === 1 ? '' : 's'))
              .join(', ') +
            (r.counts.repeated ? ' · ' + r.counts.repeated + ' repetidos' : '') +
            '.',
        );
        preview = null;
        draft.content = '';
        draft.filename = '';
        return 'reload';
      }
      if (name === 'leg-remove') {
        if (!confirm('¿Quitar este lote? Sus registros históricos se borran; las personas se conservan.')) return true;
        const r = await api('/api/legacy/batches/' + el.dataset.id, { method: 'DELETE' });
        toast(r.removed + ' registros quitados.');
        return 'reload';
      }
    } catch (e) {
      toast(e.message);
      return true;
    }
    return false;
  }
  async function submit(form) {
    if (form.getAttribute('id') !== 'leg-form') return false;
    keep();
    const feedback = msg => {
      const f = form.querySelector('.ops-feedback');
      if (f) f.textContent = msg;
    };
    try {
      preview = await api('/api/legacy/preview', { method: 'POST', body: { ...draft } });
      return 'reload';
    } catch (e) {
      feedback(e.message);
      toast(e.message);
      return true;
    }
  }
  return { load, html, action, submit };
};
