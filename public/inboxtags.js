// Etiquetas en la bandeja (docs/PLAN_ETIQUETAS_BANDEJA.md): chips en cada hilo, filtro por etiqueta y botón «Etiquetas» en el chat.
// Las etiquetas son las de Contactos (por marca): aquí sólo se ven y se aplican más rápido; no hay datos nuevos.
window.createInboxTagsUI = function ({ state, api, esc, icon, showModal, toast, reload }) {
  const $ = s => document.querySelector(s);
  let tags = [],
    loaded = false,
    loading = null;
  const brandName = id => state.brands.find(b => b.id === id)?.name || '';
  const visible = () => tags.filter(t => state.brand === 'all' || t.brand_id === state.brand);
  const chip = t => `<span class="ctc-tag ${esc(t.color || '')}">${esc(t.name)}</span>`;
  const options = () =>
    '<option value="">Todas las etiquetas</option>' +
    visible()
      .map(
        t =>
          `<option value="${esc(t.id)}" ${state.tag === t.id ? 'selected' : ''}>${esc(t.name)}${state.brand === 'all' ? ' · ' + esc(brandName(t.brand_id)) : ''} (${t.count})</option>`,
      )
      .join('');
  function paint() {
    const label = $('.tag-filter');
    if (!label) return;
    const s = $('#tag-filter');
    if (s) s.innerHTML = options();
    label.hidden = !visible().length && !state.tag;
  }
  async function load(force = false) {
    if (loaded && !force) return;
    loading ??= api('/api/crm/tags')
      .then(r => {
        tags = r.tags;
        loaded = true;
        paint();
      })
      .catch(() => {})
      .finally(() => {
        loading = null;
      });
    return loading;
  }
  const conversation = () => state.conversations.find(c => c.id === state.selected) || null;

  function chips(c) {
    const list = c.tags || [];
    if (!list.length) return '';
    return `<div class="thread-tags">${list.slice(0, 2).map(chip).join('')}${list.length > 2 ? `<span class="ctc-tag">+${list.length - 2}</span>` : ''}</div>`;
  }
  const inline = c => (c.tags || []).slice(0, 4).map(chip).join(' ');
  function filterHtml() {
    load();
    return `<label class="tag-filter" ${loaded && !visible().length && !state.tag ? 'hidden' : ''}>${icon('tag')}<select id="tag-filter" aria-label="Filtrar por etiqueta">${options()}</select></label>`;
  }

  async function open() {
    await load();
    const c = conversation();
    if (!c) return;
    if (!c.contact_id) {
      toast('Esta conversación todavía no tiene ficha de contacto.');
      return;
    }
    const own = tags.filter(t => t.brand_id === c.brand_id),
      mine = new Set((c.tags || []).map(t => t.id));
    showModal(
      'Etiquetas · ' + (c.customer_name || 'contacto'),
      `<form id="tg-form" class="form-grid"><input type="hidden" name="conversationId" value="${esc(c.id)}">
      <div class="tg-list">${own.map(t => `<label class="tg-item"><input type="checkbox" name="tag" value="${esc(t.id)}" ${mine.has(t.id) ? 'checked' : ''}> ${chip(t)}</label>`).join('') || '<p class="crm-hint">Esta marca todavía no tiene etiquetas. Crea la primera abajo.</p>'}</div>
      <label class="field">Nueva etiqueta (opcional)<input name="newTag" maxlength="30" placeholder="Por ejemplo: Pidió beca"></label>
      <p class="crm-hint">Las etiquetas son las de Contactos y sirven para filtrar la bandeja y segmentar campañas.</p>
      <div class="actions"><button class="btn primary" type="submit">Guardar</button></div><div class="ops-feedback" role="status"></div></form>`,
    );
  }
  async function submit(form) {
    if (form.getAttribute('id') !== 'tg-form') return false;
    const f = new FormData(form),
      c = state.conversations.find(x => x.id === f.get('conversationId')),
      feedback = m => {
        const x = form.querySelector('.ops-feedback');
        if (x) x.textContent = m;
      };
    if (!c) return true;
    try {
      const ids = f.getAll('tag'),
        name = String(f.get('newTag') || '').trim();
      if (name) {
        const r = await api('/api/crm/tags', { method: 'POST', body: { brandId: c.brand_id, name, color: 'neutral' } });
        ids.push(r.tag.id);
      }
      await api('/api/crm/contacts/' + c.contact_id + '/tags', { method: 'PUT', body: { tagIds: ids } });
      await load(true);
      c.tags = ids
        .map(id => tags.find(t => t.id === id))
        .filter(Boolean)
        .map(t => ({ id: t.id, name: t.name, color: t.color }));
      $('#modal')?.close();
      toast('Etiquetas guardadas.');
      reload();
    } catch (e) {
      feedback(e.message);
      toast(e.message);
    }
    return true;
  }
  async function action(name) {
    if (name === 'tg-open') {
      await open();
      return true;
    }
    return false;
  }
  return { chips, inline, filterHtml, action, submit, load, paint };
};
