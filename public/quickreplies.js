// Chat más rápido (docs/PLAN_CHAT_RAPIDO.md): respuestas rápidas con «/» en el compositor, su administración en Mi configuración y
// «Recordarme» desde el chat. Insertar una respuesta NO envía nada: la persona la revisa y la envía como siempre.
window.createQuickRepliesUI = function ({ state, api, esc, icon, showModal, toast }) {
  if (window.__qrUI) return window.__qrUI;
  const $ = s => document.querySelector(s);
  const TOKEN = /(^|\s)\/([\p{L}\p{N}_-]*)$/u;
  const chip = (label, kind = '') => `<span class="ops-chip ${kind}">${esc(label)}</span>`;
  let data = null,
    loading = null,
    menu = { open: false, items: [], index: 0 },
    suppress = false;

  async function ensure(force = false) {
    if (data && !force) return data;
    loading ??= api('/api/quick-replies')
      .then(r => {
        data = r;
        return r;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }
  const currentConversation = () => state.conversations.find(c => c.id === state.selected) || null;
  function candidates(query) {
    const q = query.toLowerCase(),
      brand = currentConversation()?.brand_id;
    const rows = (data?.quickReplies || [])
      .filter(r => r.scope === 'personal' || r.brandId === brand)
      .filter(r => !q || r.shortcut.includes(q) || r.title.toLowerCase().includes(q));
    return rows
      .sort(
        (a, b) =>
          b.shortcut.startsWith(q) - a.shortcut.startsWith(q) ||
          b.uses - a.uses ||
          a.shortcut.localeCompare(b.shortcut),
      )
      .slice(0, 8);
  }

  // ---- menú «/» sobre el compositor
  function close() {
    menu = { open: false, items: [], index: 0 };
    $('#slash-menu')?.remove();
  }
  function draw(query) {
    const form = $('#message-form');
    if (!form) return;
    $('#slash-menu')?.remove();
    const body = menu.items.length
      ? menu.items
          .map(
            (r, i) =>
              `<button type="button" class="slash-item ${i === menu.index ? 'active' : ''}" role="option" aria-selected="${i === menu.index}" data-qr="${esc(r.id)}"><span class="slash-key">/${esc(r.shortcut)}</span><span class="slash-copy"><strong>${esc(r.title)}</strong><small>${esc(r.body.replace(/\s+/g, ' ').slice(0, 90))}</small></span>${r.scope === 'brand' ? chip('Marca') : ''}</button>`,
          )
          .join('')
      : `<div class="slash-empty">${data?.quickReplies?.length ? 'Ninguna respuesta coincide con «/' + esc(query) + '».' : 'Todavía no tienes respuestas rápidas.'} Créalas en <strong>Mi configuración → Respuestas rápidas</strong>. <button type="button" class="btn" data-action="qr-go-settings">${data?.quickReplies?.length ? 'Crear otra respuesta' : 'Crear mi primera respuesta'}</button></div>`;
    form.insertAdjacentHTML(
      'afterbegin',
      `<div id="slash-menu" class="slash-menu" role="listbox" aria-label="Respuestas rápidas">${body}</div>`,
    );
  }
  async function update(textarea) {
    if (suppress) {
      suppress = false;
      return;
    }
    const before = textarea.value.slice(0, textarea.selectionStart),
      m = before.match(TOKEN);
    if (!m) {
      if (menu.open) close();
      return;
    }
    try {
      await ensure();
    } catch {
      return;
    }
    if (!document.body.contains(textarea)) return;
    const again = textarea.value.slice(0, textarea.selectionStart).match(TOKEN);
    if (!again) {
      close();
      return;
    }
    menu = { open: true, items: candidates(again[2]), index: 0 };
    draw(again[2]);
  }
  async function pick(id) {
    const textarea = $('#message-input'),
      c = currentConversation();
    if (!textarea || !c) return;
    try {
      const r = await api('/api/quick-replies/' + id + '/render', { method: 'POST', body: { conversationId: c.id } });
      const caret = textarea.selectionStart,
        before = textarea.value.slice(0, caret),
        m = before.match(TOKEN),
        start = m ? before.length - m[2].length - 1 : caret;
      textarea.value = textarea.value.slice(0, start) + r.text + textarea.value.slice(caret);
      const end = start + r.text.length;
      textarea.setSelectionRange(end, end);
      textarea.focus();
      close();
      suppress = true;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      if (data) {
        const q = data.quickReplies.find(x => x.id === id);
        if (q) q.uses++;
      }
    } catch (e) {
      toast(e.message);
    }
  }
  document.addEventListener('input', e => {
    if (e.target.id === 'message-input') update(e.target);
  });
  document.addEventListener(
    'keydown',
    e => {
      if (!menu.open || e.target.id !== 'message-input') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (!menu.items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        menu.index = (menu.index + (e.key === 'ArrowDown' ? 1 : menu.items.length - 1)) % menu.items.length;
        document.querySelectorAll('#slash-menu .slash-item').forEach((el, i) => {
          el.classList.toggle('active', i === menu.index);
          el.setAttribute('aria-selected', i === menu.index);
        });
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        pick(menu.items[menu.index].id);
      }
    },
    true,
  );
  document.addEventListener('mousedown', e => {
    if (e.target.closest('.slash-item')) e.preventDefault();
  }); // no quita el foco al compositor
  document.addEventListener('click', e => {
    const item = e.target.closest('.slash-item');
    if (item) {
      pick(item.dataset.qr);
      return;
    }
    if (menu.open && !e.target.closest('#slash-menu,#message-input')) close();
  });

  // ---- «Recordarme»: un seguimiento en la oportunidad de la conversación, en un clic
  function remind() {
    const c = currentConversation();
    if (!c) return;
    if (!c.opportunity_id) {
      toast('Esta conversación todavía no tiene oportunidad para dar seguimiento.');
      return;
    }
    const at = (days, h, m = 0) => {
        const d = new Date();
        d.setDate(d.getDate() + days);
        d.setHours(h, m, 0, 0);
        return d.getTime();
      },
      now = Date.now();
    const options = [
      ['En 1 hora', now + 3600000],
      ...(at(0, 18) > now + 900000 ? [['Hoy a las 6 p. m.', at(0, 18)]] : []),
      ['Mañana a las 9 a. m.', at(1, 9)],
      ['En 3 días, 9 a. m.', at(3, 9)],
      ['En 1 semana, 9 a. m.', at(7, 9)],
    ];
    showModal(
      'Recordarme dar seguimiento',
      `<p class="crm-hint">Crea una tarea en la oportunidad de <strong>${esc(c.customer_name || 'este cliente')}</strong> y te avisa en Mi día cuando llegue la hora.</p>
      <label class="field">Nota (opcional)<input id="qr-remind-note" maxlength="100" placeholder="Por ejemplo: preguntar si ya pagó"></label>
      <div class="qr-remind">${options.map(([label, t]) => `<button type="button" class="btn" data-action="qr-remind-at" data-at="${t}">${esc(label)}</button>`).join('')}</div>`,
    );
  }
  async function remindAt(el) {
    const c = currentConversation(),
      note = ($('#qr-remind-note')?.value || '').trim().slice(0, 100);
    if (!c) return;
    const title = (
      'Retomar con ' +
      (c.customer_name || 'el cliente') +
      ' · ' +
      (c.course_title || '') +
      (note ? ' — ' + note : '')
    ).slice(0, 180);
    await api('/api/crm/tasks', {
      method: 'POST',
      body: { opportunityId: c.opportunity_id, title, dueAt: Number(el.dataset.at) },
    });
    $('#modal')?.close();
    toast('Listo: te lo recordaré en Mi día.');
  }

  // ---- administración en Mi configuración
  const SAMPLE = {
    nombre: 'Ana',
    nombre_completo: 'Ana López',
    curso: 'Curso de ejemplo',
    edicion: 'Primera edición',
    asesor: 'tu nombre',
  };
  const preview = (body, brand) =>
    esc(
      body.replace(
        /\{\{([^{}]+)\}\}/g,
        (m, k) =>
          ({ ...SAMPLE, marca: brand || 'tu marca', asesor: (state.user?.name || '').split(' ')[0] || SAMPLE.asesor })[
            k.trim()
          ] ?? m,
      ),
    );
  const hl = body => esc(body).replace(/\{\{([^{}]+)\}\}/g, '<mark>{{$1}}</mark>');
  const groupsOf = () => [...new Set(data.starter.map(x => x.group))];
  let filter = 'all',
    search = '';
  const slug = t =>
    t
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  // corta en una palabra completa (hasta 20 caracteres) para que el atajo no quede a medias
  const short = t => {
    const x = slug(t);
    if (x.length <= 20) return x;
    const cut = x.slice(0, 21),
      i = cut.lastIndexOf('-');
    return i >= 3 ? cut.slice(0, i) : x.slice(0, 20);
  };

  function rowHtml(r) {
    return `<article class="qr-row"><span class="slash-key">/${esc(r.shortcut)}</span><div class="qr-copy"><strong>${esc(r.title)}</strong><p class="qr-text">${hl(r.body)}</p><small>${r.scope === 'brand' ? 'Compartida · ' + esc(r.brandName) : 'Sólo tuya'} · ${r.uses ? `usada ${r.uses} ${r.uses === 1 ? 'vez' : 'veces'}` : 'todavía sin usar'}</small></div>${r.editable ? `<div class="qr-actions"><button type="button" class="btn" data-action="qr-edit" data-id="${esc(r.id)}">Editar</button><button type="button" class="btn" data-action="qr-dup" data-id="${esc(r.id)}">Duplicar</button><button type="button" class="btn" data-action="qr-archive" data-id="${esc(r.id)}" aria-label="Archivar /${esc(r.shortcut)}">Archivar</button></div>` : '<div class="qr-actions"><small>La administra administración</small></div>'}</article>`;
  }
  function listHtml() {
    const q = search.trim().toLowerCase().replace(/^\//, '');
    const rows = data.quickReplies
      .filter(
        r =>
          filter === 'all' ||
          (filter === 'mine' && r.scope === 'personal') ||
          (filter === 'shared' && r.scope === 'brand'),
      )
      .filter(
        r => !q || r.shortcut.includes(q) || r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q),
      );
    if (!data.quickReplies.length)
      return `<div class="qr-empty"><strong>Todavía no hay respuestas rápidas</strong><p>Son textos que insertas en el chat escribiendo <b>/</b> y un atajo. Lo más fácil es empezar con ejemplos listos y ajustarlos a tu estilo.</p><button type="button" class="btn primary" data-action="qr-library">${icon('sparkles')} Empezar con ejemplos</button></div>`;
    if (!rows.length) return '<p class="crm-hint">Ninguna respuesta coincide con tu búsqueda.</p>';
    return rows.map(rowHtml).join('');
  }
  function paintList() {
    const el = $('#qr-list');
    if (el) {
      el.innerHTML = listHtml();
      window.lucide?.createIcons({ attrs: { 'stroke-width': 1.7 } });
    }
  }
  async function mount() {
    const box = $('#qr-panel');
    if (!box) return;
    try {
      await ensure(true);
    } catch {
      box.innerHTML = '';
      return;
    }
    if (!$('#qr-panel')) return;
    const has = data.quickReplies.length > 0,
      mineN = data.quickReplies.filter(r => r.scope === 'personal').length,
      sharedN = data.quickReplies.length - mineN;
    box.innerHTML = `<h3 class="modal-section-title">Respuestas rápidas</h3><p class="crm-hint">En el chat escribe <strong>/</strong> y el atajo para insertar el texto, ya con el nombre del cliente y el curso. No se envía hasta que tú lo envíes. Para precios, fechas y cupos usa las plantillas aprobadas: ahí sí salen del catálogo vigente.</p>
      <div class="qr-head"><div class="qr-bar"><button type="button" class="btn primary" data-action="qr-new">${icon('plus')} Nueva respuesta</button><button type="button" class="btn" data-action="qr-library">${icon('sparkles')} Ejemplos listos</button></div>
      ${has ? `<div class="qr-tools"><label class="qr-search"><span class="sr-only">Buscar respuestas rápidas</span>${icon('search')}<input id="qr-search" type="search" placeholder="Buscar por atajo, nombre o texto" value="${esc(search)}" autocomplete="off"></label><div class="qr-filters" role="group" aria-label="Filtrar">${[['all', 'Todas', data.quickReplies.length], ['mine', 'Mías', mineN], ...(sharedN ? [['shared', 'Compartidas', sharedN]] : [])].map(([id, t, n]) => `<button type="button" data-action="qr-filter" data-id="${id}" class="${filter === id ? 'active' : ''}" aria-pressed="${filter === id}">${t} <span>${n}</span></button>`).join('')}</div></div>` : ''}</div>
      <div id="qr-list" class="qr-list">${listHtml()}</div>`;
    window.lucide?.createIcons({ attrs: { 'stroke-width': 1.7 } });
  }

  // ---- crear y editar, con vista previa en vivo
  const brandOf = () => {
    const id = $('#qr-form [name=brandId]')?.value,
      scope = $('#qr-form [name=scope]:checked')?.value;
    return (scope === 'brand' && data.brands.find(b => b.id === id)?.name) || data.brands[0]?.name || '';
  };
  function paintPreview() {
    const body = $('#qr-body')?.value || '',
      box = $('#qr-preview');
    if (!box) return;
    box.innerHTML = body.trim()
      ? preview(body, brandOf())
      : '<span class="qr-muted">Aquí verás cómo le llegará al cliente.</span>';
    const n = $('#qr-count');
    if (n) n.textContent = body.length + ' / 1500';
  }
  function form(r, seed = null) {
    const vars = Object.entries(data.variables),
      v = r || seed || {};
    const scopeCards = r
      ? ''
      : `<fieldset class="qr-scope"><legend>¿Quién la usa?</legend><label class="qr-card"><input type="radio" name="scope" value="personal" checked><span><strong>Sólo yo</strong><small>Aparece únicamente en tus chats.</small></span></label>${data.canShare ? `<label class="qr-card"><input type="radio" name="scope" value="brand"><span><strong>Todo el equipo de una marca</strong><small>La ven y la usan todas las personas de esa marca.</small></span></label>` : ''}</fieldset><label class="field" id="qr-brand-field" hidden>Marca<select name="brandId">${data.brands.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></label>`;
    showModal(
      r ? 'Editar respuesta rápida' : 'Nueva respuesta rápida',
      `<form id="qr-form" class="form-grid"><input type="hidden" name="id" value="${esc(r?.id || '')}"><input type="hidden" name="expectedRevision" value="${r?.revision || ''}">
      ${scopeCards}
      <label class="field">Nombre<input name="title" id="qr-title" required maxlength="60" value="${esc(v.title || '')}" placeholder="Agradecer y ofrecer ayuda"></label>
      <label class="field">Atajo <small class="qr-muted">lo que escribes después de «/»</small><input name="shortcut" id="qr-shortcut" required maxlength="20" autocapitalize="none" spellcheck="false" value="${esc(v.shortcut || '')}" placeholder="gracias"></label>
      <label class="field">Texto <small class="qr-muted" id="qr-count"></small><textarea name="body" id="qr-body" required rows="5" maxlength="1500" placeholder="Hola {{nombre}}, gracias por tu interés en {{curso}}. Soy {{asesor}} de {{marca}}.">${esc(v.body || '')}</textarea></label>
      <div><small class="qr-muted">Toca para insertar un dato del cliente:</small><div class="qr-vars" aria-label="Variables">${vars.map(([k, label]) => `<button type="button" class="btn" data-action="qr-var" data-id="${esc(k)}" title="${esc(label)}">{{${esc(k)}}}</button>`).join('')}</div></div>
      <div><small class="qr-muted">Así le llegará (con datos de ejemplo):</small><div id="qr-preview" class="qr-preview" aria-live="polite"></div></div>
      <div class="actions"><button class="btn primary" type="submit">${r ? 'Guardar cambios' : 'Guardar'}</button><button type="button" class="btn" data-action="close-modal">Cancelar</button></div><div class="ops-feedback" role="status"></div></form>`,
    );
    paintPreview();
  }

  // ---- biblioteca de ejemplos
  function library(dest = 'personal') {
    const have = new Set(
        data.quickReplies
          .filter(r => (dest === 'personal' ? r.scope === 'personal' : r.brandId === dest))
          .map(r => r.shortcut),
      ),
      missing = data.starter.filter(s => !have.has(s.shortcut));
    const target =
      dest === 'personal' ? 'mis respuestas' : 'las de ' + (data.brands.find(b => b.id === dest)?.name || 'la marca');
    showModal(
      'Ejemplos listos para usar',
      `<p class="crm-hint">Agrega las que te sirvan y cámbialas cuando quieras. Ninguna lleva precios ni fechas: eso lo pones tú o sale de las plantillas aprobadas.</p>
      <div class="qr-lib-top"><label class="field">Agregar a<select id="qr-lib-dest"><option value="personal" ${dest === 'personal' ? 'selected' : ''}>Mis respuestas (sólo yo)</option>${data.canShare ? data.brands.map(b => `<option value="${esc(b.id)}" ${dest === b.id ? 'selected' : ''}>Todo el equipo de ${esc(b.name)}</option>`).join('') : ''}</select></label>
      <button type="button" class="btn primary" data-action="qr-add-all" ${missing.length ? '' : 'disabled'}>${missing.length ? `Agregar las ${missing.length} que faltan a ${esc(target)}` : 'Ya tienes todas'}</button></div>
      <label class="qr-search qr-lib-search"><span class="sr-only">Buscar entre los ejemplos</span>${icon('search')}<input id="qr-lib-search" type="search" placeholder="Buscar: caro, pago pendiente, bienvenida…" autocomplete="off"></label>
      ${groupsOf()
        .map(g => {
          const rows = data.starter.filter(s => s.group === g),
            todo = rows.filter(s => !have.has(s.shortcut));
          return `<section class="qr-lib-group" data-group><div class="qr-group-head"><h4 class="qr-group">${esc(g)} <span>${rows.length}</span></h4>${todo.length ? `<button type="button" class="btn" data-action="qr-add-group" data-id="${esc(g)}">Agregar las ${todo.length}</button>` : '<small>Ya las tienes</small>'}</div>${rows.map(s => `<article class="qr-row" data-find="${esc((s.shortcut + ' ' + s.title + ' ' + s.body).toLowerCase())}"><span class="slash-key">/${esc(s.shortcut)}</span><div class="qr-copy"><strong>${esc(s.title)}</strong><p class="qr-text">${preview(s.body, data.brands[0]?.name)}</p></div><div class="qr-actions">${have.has(s.shortcut) ? '<small>Ya la tienes</small>' : `<button type="button" class="btn" data-action="qr-add-one" data-shortcut="${esc(s.shortcut)}">Agregar</button>`}</div></article>`).join('')}</section>`;
        })
        .join('')}`,
    );
    const sel = $('#qr-lib-dest');
    if (sel && dest !== sel.value) sel.value = dest;
  }
  function filterLibrary(q) {
    const t = q.trim().toLowerCase().replace(/^\//, '');
    let any = false;
    document.querySelectorAll('#modal [data-group]').forEach(g => {
      let n = 0;
      g.querySelectorAll('.qr-row').forEach(r => {
        const ok = !t || r.dataset.find.includes(t);
        r.hidden = !ok;
        if (ok) n++;
      });
      g.hidden = !n;
      if (n) any = true;
    });
    let none = document.querySelector('#qr-lib-none');
    if (!any && !none) {
      document
        .querySelector('#modal [data-group]:last-of-type')
        ?.insertAdjacentHTML(
          'afterend',
          '<p id="qr-lib-none" class="crm-hint">Ningún ejemplo coincide. Prueba con otra palabra.</p>',
        );
    }
    if (any) none?.remove();
  }
  async function addStarter(shortcuts) {
    const dest = $('#qr-lib-dest')?.value || 'personal',
      scope = dest === 'personal' ? 'personal' : 'brand';
    let added = 0,
      skipped = 0;
    for (const sc of shortcuts) {
      const s = data.starter.find(x => x.shortcut === sc);
      if (!s) continue;
      try {
        await api('/api/quick-replies', {
          method: 'POST',
          body: {
            shortcut: s.shortcut,
            title: s.title,
            body: s.body,
            scope,
            brandId: scope === 'brand' ? dest : undefined,
            clientRef: crypto.randomUUID(),
          },
        });
        added++;
      } catch (e) {
        if (/Ya existe|máximo/.test(e.message)) {
          skipped++;
          if (/máximo/.test(e.message)) break;
        } else throw e;
      }
    }
    await ensure(true);
    library(dest);
    paintList();
    toast(
      added
        ? `Agregué ${added} ${added === 1 ? 'respuesta' : 'respuestas'}.${skipped ? ' ' + skipped + ' ya existían.' : ''}`
        : 'No había nada nuevo que agregar.',
    );
  }
  document.addEventListener('input', e => {
    if (e.target.id === 'qr-search') {
      search = e.target.value;
      paintList();
      return;
    }
    if (e.target.id === 'qr-lib-search') {
      filterLibrary(e.target.value);
      return;
    }
    if (e.target.id === 'qr-body') paintPreview();
    if (e.target.id === 'qr-title') {
      const sc = $('#qr-shortcut');
      if (sc && !sc.dataset.touched && !$('#qr-form [name=id]')?.value) sc.value = short(e.target.value);
    }
    if (e.target.id === 'qr-shortcut') e.target.dataset.touched = '1';
  });
  document.addEventListener('change', e => {
    if (e.target.matches('#qr-form [name=scope]')) {
      $('#qr-brand-field').hidden = e.target.value !== 'brand';
      paintPreview();
    }
    if (e.target.matches('#qr-form [name=brandId]')) paintPreview();
    if (e.target.id === 'qr-lib-dest') library(e.target.value);
  });
  async function action(name, el) {
    try {
      if (name === 'qr-open') {
        const t = $('#message-input');
        if (!t) return true;
        t.focus();
        const caret = t.selectionStart,
          before = t.value.slice(0, caret);
        if (!TOKEN.test(before)) {
          const lead = before && !/\s$/.test(before) ? ' /' : '/';
          t.value = before + lead + t.value.slice(caret);
          const pos = before.length + lead.length;
          t.setSelectionRange(pos, pos);
        }
        t.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      if (name === 'qr-go-settings') {
        close();
        document.querySelector('[data-view="settings"]')?.click();
        for (let i = 0; i < 30 && !document.querySelector('[data-action="qr-new"]'); i++)
          await new Promise(r => setTimeout(r, 100));
        document.querySelector('[data-action="qr-new"]')?.click();
        return true;
      }
      if (name === 'qr-remind') {
        remind();
        return true;
      }
      if (name === 'qr-remind-at') {
        await remindAt(el);
        return true;
      }
      if (name === 'qr-new') {
        await ensure();
        form(null);
        return true;
      }
      if (name === 'qr-dup') {
        await ensure();
        const r = data.quickReplies.find(x => x.id === el.dataset.id);
        if (r) {
          form(null, {
            shortcut: (r.shortcut + '-2').slice(0, 20),
            title: (r.title + ' (copia)').slice(0, 60),
            body: r.body,
          });
        }
        return true;
      }
      if (name === 'qr-filter') {
        filter = el.dataset.id;
        await mount();
        return true;
      }
      if (name === 'qr-library') {
        await ensure();
        library();
        return true;
      }
      if (name === 'qr-add-group') {
        const dest = $('#qr-lib-dest')?.value || 'personal',
          have = new Set(
            data.quickReplies
              .filter(r => (dest === 'personal' ? r.scope === 'personal' : r.brandId === dest))
              .map(r => r.shortcut),
          );
        await addStarter(
          data.starter.filter(x => x.group === el.dataset.id && !have.has(x.shortcut)).map(x => x.shortcut),
        );
        return true;
      }
      if (name === 'qr-add-one') {
        await addStarter([el.dataset.shortcut]);
        return true;
      }
      if (name === 'qr-add-all') {
        const dest = $('#qr-lib-dest')?.value || 'personal',
          have = new Set(
            data.quickReplies
              .filter(r => (dest === 'personal' ? r.scope === 'personal' : r.brandId === dest))
              .map(r => r.shortcut),
          );
        await addStarter(data.starter.filter(x => !have.has(x.shortcut)).map(x => x.shortcut));
        return true;
      }
      if (name === 'qr-edit') {
        await ensure();
        form(data.quickReplies.find(x => x.id === el.dataset.id));
        return true;
      }
      if (name === 'qr-archive') {
        if (!confirm('¿Archivar esta respuesta rápida? Su atajo queda libre.')) return true;
        await api('/api/quick-replies/' + el.dataset.id, { method: 'DELETE' });
        toast('Respuesta archivada.');
        await mount();
        return true;
      }
      if (name === 'qr-var') {
        const t = $('#qr-body');
        if (t) {
          const s = t.selectionStart,
            v = '{{' + el.dataset.id + '}}';
          t.value = t.value.slice(0, s) + v + t.value.slice(t.selectionEnd);
          t.setSelectionRange(s + v.length, s + v.length);
          t.focus();
        }
        return true;
      }
    } catch (e) {
      toast(e.message);
      return true;
    }
    return false;
  }
  async function submit(formEl) {
    if (formEl.getAttribute('id') !== 'qr-form') return false;
    const f = new FormData(formEl),
      id = f.get('id'),
      feedback = m => {
        const x = formEl.querySelector('.ops-feedback');
        if (x) x.textContent = m;
      };
    const payload = { shortcut: f.get('shortcut'), title: f.get('title'), body: f.get('body') };
    try {
      if (id)
        await api('/api/quick-replies/' + id, {
          method: 'PATCH',
          body: { ...payload, expectedRevision: Number(f.get('expectedRevision')) },
        });
      else
        await api('/api/quick-replies', {
          method: 'POST',
          body: {
            ...payload,
            scope: f.get('scope') || 'personal',
            brandId: f.get('brandId') || undefined,
            clientRef: crypto.randomUUID(),
          },
        });
      $('#modal')?.close();
      toast('Respuesta rápida guardada.');
      await mount();
    } catch (e) {
      feedback(e.message);
      toast(e.message);
    }
    return true;
  }
  const ui = { mount, action, submit, reload: () => ensure(true) };
  window.__qrUI = ui;
  return ui;
};
