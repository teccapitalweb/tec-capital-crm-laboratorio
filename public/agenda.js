// Agenda semanal de citas (docs/PLAN_AGENDA_CITAS.md, vista semanal). Una semana de lunes a domingo con las citas de cada día, las propias o las de todo
// el equipo (las marcas que la persona ve; el selector de marca del menú la filtra). Cada cita abre su chat. Sólo lectura: las citas se agendan y se
// cambian desde el chat. Las acciones llevan el prefijo «agd-».
window.createAgendaUI = function ({ state, api, esc, icon, icons, toast }) {
  const $ = s => document.querySelector(s);
  const KIND = {
    llamada: ['Llamada', 'phone'],
    videollamada: ['Videollamada', 'video'],
    presencial: ['Presencial', 'map-pin'],
  };
  const STATE = { done: 'Se hizo', no_show: 'No asistió' };
  const mondayOf = t => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  };
  const addDays = (t, n) => {
    const d = new Date(t);
    d.setDate(d.getDate() + n);
    return d.getTime();
  };
  const hm = t => new Date(t).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
  let weekStart = mondayOf(Date.now()),
    scope = 'mine',
    items = [],
    loaded = false,
    version = 0,
    failed = false;
  const nav = () =>
    `<button data-view="agenda" class="${state.view === 'agenda' ? 'active' : ''}" aria-label="Agenda de citas" title="Agenda de citas">${icon('calendar-days')}<span class="nav-label-text">Agenda</span></button>`;
  const rangeLabel = () => {
    const a = new Date(weekStart),
      b = new Date(addDays(weekStart, 6));
    const m = d => d.toLocaleDateString('es-MX', { month: 'short' }).replace('.', '');
    return a.getMonth() === b.getMonth()
      ? `${a.getDate()}–${b.getDate()} ${m(b)} ${b.getFullYear()}`
      : `${a.getDate()} ${m(a)} – ${b.getDate()} ${m(b)} ${b.getFullYear()}`;
  };

  function card(i, now) {
    const [kl, ki] = KIND[i.kind] || KIND.llamada,
      over = i.state === 'scheduled' && i.endsAt < now;
    return `<button type="button" class="agd-card agd-${esc(i.state)}${over ? ' agd-over' : ''}" data-action="crm-chat" data-id="${esc(i.conversationId)}" title="Abrir la conversación">
      <time>${icon(ki)}${esc(hm(i.startsAt))}–${esc(hm(i.endsAt))}</time><strong>${esc(i.title)}</strong>
      <small>${esc(i.customerName || 'Cliente')} · ${esc(i.brandName || '')}</small>
      <small>${esc(kl)}${scope === 'team' && !i.mine ? ' · ' + esc(i.ownerName || 'el equipo') : ''}</small>
      ${STATE[i.state] ? `<span class="agd-tag">${esc(STATE[i.state])}</span>` : over ? '<span class="agd-tag agd-warn">Ya terminó: ciérrala en el chat</span>' : ''}
    </button>`;
  }
  function draw() {
    const page = $('#page');
    if (!page) return;
    const now = Date.now(),
      today = new Date().setHours(0, 0, 0, 0),
      days = Array.from({ length: 7 }, (_, n) => addDays(weekStart, n));
    const by = new Map(days.map(d => [d, []]));
    for (const i of items) {
      const d = days.find(x => i.startsAt >= x && i.startsAt < addDays(x, 1));
      if (d !== undefined) by.get(d).push(i);
    }
    const count = items.length;
    page.innerHTML = `<div class="content-page agenda-page"><div class="page-heading"><div><span class="eyebrow">Citas · ${state.brand === 'all' ? 'todas mis marcas' : esc(state.brands?.find(b => b.id === state.brand)?.name || 'una marca')}</span><h1>${scope === 'mine' ? 'Tu semana.' : 'La semana del equipo.'}</h1><p>Llamadas, videollamadas y citas presenciales. Se agendan desde el chat de cada persona.</p></div></div>
      <div class="agd-bar"><div class="agd-nav" role="group" aria-label="Cambiar de semana"><button type="button" class="btn" data-action="agd-prev" aria-label="Semana anterior">${icon('chevron-left')}</button><button type="button" class="btn" data-action="agd-today">Hoy</button><button type="button" class="btn" data-action="agd-next" aria-label="Semana siguiente">${icon('chevron-right')}</button></div>
        <strong class="agd-range" aria-live="polite">${esc(rangeLabel())}</strong>
        <div class="agd-scope" role="group" aria-label="Qué citas ver"><button type="button" class="${scope === 'mine' ? 'active' : ''}" data-action="agd-scope" data-scope="mine" aria-pressed="${scope === 'mine'}">Mías</button><button type="button" class="${scope === 'team' ? 'active' : ''}" data-action="agd-scope" data-scope="team" aria-pressed="${scope === 'team'}">Del equipo</button></div>
        <small class="agd-count">${loaded ? (count === 1 ? '1 cita' : count + ' citas') : 'Cargando…'}</small></div>
      ${failed ? '<div class="crm-panel agd-empty"><strong>No pudimos cargar la agenda.</strong><span>Vuelve a intentarlo en un momento.</span></div>' : ''}
      <div class="agd-week">${days
        .map(d => {
          const list = by.get(d),
            dt = new Date(d);
          return `<section class="agd-day${d === today ? ' agd-today' : ''}${d < today ? ' agd-pastday' : ''}" aria-label="${esc(dt.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }))}">
        <header><span>${esc(dt.toLocaleDateString('es-MX', { weekday: 'short' }).replace('.', ''))}</span><b>${dt.getDate()}</b>${list.length ? `<small>${list.length}</small>` : ''}</header>
        ${list.map(i => card(i, now)).join('') || '<p class="agd-none">Sin citas</p>'}</section>`;
        })
        .join('')}</div>
      ${loaded && !count && !failed ? `<p class="agd-hint">${scope === 'mine' ? 'No tienes citas esta semana.' : 'El equipo no tiene citas esta semana.'} Para agendar una, abre un chat y toca «Agendar cita».</p>` : ''}</div>`;
    icons?.();
  }
  async function load() {
    const my = ++version;
    failed = false;
    const q = new URLSearchParams({ from: weekStart, to: addDays(weekStart, 7), scope });
    if (state.brand && state.brand !== 'all') q.set('brand', state.brand);
    try {
      const r = await api('/api/appointments?' + q);
      if (my !== version) return;
      items = r.items;
      loaded = true;
    } catch (e) {
      if (my !== version) return;
      items = [];
      loaded = true;
      failed = true;
      toast(e.message);
    }
    if (state.view === 'agenda') draw();
  }
  async function render() {
    loaded = false;
    draw();
    await load();
  }
  async function action(name, el) {
    if (!name.startsWith('agd-')) return false;
    if (name === 'agd-prev') weekStart = addDays(weekStart, -7);
    else if (name === 'agd-next') weekStart = addDays(weekStart, 7);
    else if (name === 'agd-today') weekStart = mondayOf(Date.now());
    else if (name === 'agd-scope') {
      scope = el.dataset.scope === 'team' ? 'team' : 'mine';
    } else return false;
    loaded = false;
    draw();
    await load();
    return true;
  }
  return { nav, render, action };
};
