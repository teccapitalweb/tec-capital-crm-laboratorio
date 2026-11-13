// Asistente para dar de alta un curso completo (docs/PLAN_ASISTENTE_CURSO.md): curso, edición con precio y fecha, imagen y publicación
// en cuatro pasos. No guarda nada hasta el último paso; entonces usa las mismas API de siempre (curso, edición, archivo, flyer y
// aprobación), así que valen todas sus reglas: precio sólo en la edición, flyer con revisión y aprobación, 4 MB, alcance por marca.
window.createCourseWizardUI = function ({
  state,
  api,
  esc,
  icon,
  icons,
  showModal,
  toast,
  field,
  select,
  opts,
  instant,
  getData,
  load,
  render,
  canApprove,
}) {
  const $ = s => document.querySelector(s);
  const STEPS = ['Curso', 'Edición', 'Imagen', 'Revisar'],
    TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'];
  const MODALITY = [
    { id: 'online', name: 'En línea' },
    { id: 'in_person', name: 'Presencial' },
    { id: 'hybrid', name: 'Híbrida' },
  ];
  let w = null,
    previewUrl = '';
  const fresh = () => ({
    step: 1,
    brandId: state.brand !== 'all' ? state.brand : state.brands[0]?.id,
    title: '',
    syllabus: '',
    ed: {
      name: 'Primera edición',
      startsAt: '',
      endsAt: '',
      timezone: 'America/Mexico_City',
      instructor: '',
      modality: 'online',
      currency: 'MXN',
      location: '',
      capacity: '',
      price: '',
      sessionPrice: '',
    },
    file: null,
    publish: true,
    approve: true,
    run: {},
  });
  const money = (n, c) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: c || 'MXN' }).format(n);
  const bar = n =>
    `<ol class="wz-steps" aria-label="Pasos del asistente">${STEPS.map((s, i) => `<li class="${i + 1 === n ? 'on' : i + 1 < n ? 'done' : ''}" ${i + 1 === n ? 'aria-current="step"' : ''}><span>${i + 1 < n ? '✓' : i + 1}</span>${s}</li>`).join('')}</ol>`;
  const nav = (n, next) =>
    `<div class="actions wz-actions">${n > 1 ? `<button type="button" class="btn" data-action="cat-wz-back">Atrás</button>` : `<button type="button" class="btn" data-action="close-modal">Cancelar</button>`}<button type="submit" class="btn primary">${next}</button></div>`;
  const frame = (n, title, hint, body, next) =>
    showModal(
      'Nuevo curso',
      `${bar(n)}<h3 class="wz-title">${title}</h3><p class="crm-hint">${hint}</p><form id="cat-wiz-form" class="form-grid" data-step="${n}">${body}<div id="wz-feedback" role="status"></div>${nav(n, next)}</form>`,
    );
  const safeZone = z => {
    try {
      new Intl.DateTimeFormat('es-MX', { timeZone: z });
      return true;
    } catch {
      return false;
    }
  };
  const when = () => {
    try {
      const t = instant(w.ed.startsAt, w.ed.timezone);
      return t;
    } catch {
      return null;
    }
  };

  function show(n) {
    w.step = n;
    if (n === 1)
      frame(
        1,
        '¿Qué curso vas a dar de alta?',
        'Marca, nombre y temario. El precio, la fecha y el docente se piden en el siguiente paso.',
        `${select('Marca', 'brandId', opts(state.brands, 'id', 'name', w.brandId))}${field('Título del curso', 'title', w.title, 'text', 'required minlength="3" maxlength="180"')}<label class="field">Temario<textarea name="syllabus" rows="6" required maxlength="5000">${esc(w.syllabus)}</textarea></label>`,
        'Siguiente',
      );
    if (n === 2) {
      const e = w.ed;
      frame(
        2,
        'La primera edición',
        'Una edición es una fecha concreta del curso, con su precio, docente y cupo. Los precios y fechas que ven los clientes salen de aquí.',
        `${field('Nombre de la edición', 'name', e.name, 'text', 'required maxlength="120"')}<div class="cat-form-columns">${field('Inicio · hora de la edición', 'startsAt', e.startsAt, 'datetime-local')}${field('Finalización (opcional)', 'endsAt', e.endsAt, 'datetime-local')}</div>${field('Zona horaria', 'timezone', e.timezone, 'text', 'required placeholder="America/Mexico_City"')}${field('Docente', 'instructor', e.instructor, 'text', 'maxlength="120"')}<div class="cat-form-columns">${select('Modalidad', 'modality', opts(MODALITY, 'id', 'name', e.modality))}${select(
          'Moneda',
          'currency',
          opts(
            ['MXN', 'USD', 'COP', 'PEN', 'EUR'].map(id => ({ id })),
            'id',
            'id',
            e.currency,
          ),
        )}</div>${field('Lugar / plataforma', 'location', e.location, 'text', 'maxlength="250"')}<div class="cat-form-columns">${field('Cupo total (opcional)', 'capacity', e.capacity, 'number', 'min="1" step="1"')}${field('Precio regular', 'price', e.price, 'number', 'required min="0" max="1000000" step="0.01"')}</div>${field('Precio por sesión (opcional)', 'sessionPrice', e.sessionPrice, 'number', 'min="0" max="1000000" step="0.01"')}`,
        'Siguiente',
      );
    }
    if (n === 3) {
      frame(
        3,
        'La imagen del curso',
        'Es el flyer que verán los clientes. PNG, JPG, WEBP, GIF o PDF de hasta 4 MB. Puedes saltar este paso y agregarla después.',
        `<label class="field">${w.file ? 'Cambiar archivo' : 'Elige la imagen o el PDF del flyer'}<input type="file" id="wz-file" accept="${TYPES.join(',')}"></label><div id="wz-file-error" role="alert"></div><div id="wz-preview">${previewHtml()}</div>`,
        w.file ? 'Siguiente' : 'Saltar este paso',
      );
    }
    if (n === 4) review();
  }
  function previewHtml() {
    if (!w.file) return '';
    return `${w.file.type.startsWith('image/') && previewUrl ? `<img class="cat-edit-image" src="${previewUrl}" alt="Vista previa de la imagen elegida">` : `<p class="crm-hint">${icon('file-text')} Documento PDF</p>`}<p class="crm-hint"><strong>${esc(w.file.name)}</strong> · ${(w.file.size / 1048576).toFixed(2)} MB</p>`;
  }
  function review() {
    const e = w.ed,
      start = when(),
      future = start !== null && start > Date.now(),
      brand = state.brands.find(b => b.id === w.brandId)?.name || '',
      fmt =
        start === null
          ? 'Por confirmar'
          : new Intl.DateTimeFormat('es-MX', { dateStyle: 'long', timeStyle: 'short', timeZone: e.timezone }).format(
              start,
            );
    const rows = [
      ['Marca', brand],
      ['Curso', w.title],
      ['Edición', e.name],
      ['Inicio', fmt],
      ['Docente', e.instructor || 'Por confirmar'],
      ['Modalidad', MODALITY.find(m => m.id === e.modality)?.name + (e.location ? ' · ' + e.location : '')],
      [
        'Precio',
        money(Number(e.price), e.currency) +
          (e.sessionPrice ? ' · por sesión ' + money(Number(e.sessionPrice), e.currency) : ''),
      ],
      ['Cupo', e.capacity || 'Sin límite informado'],
      ['Imagen', w.file ? w.file.name : 'Sin imagen por ahora'],
    ];
    const canPublish = future;
    frame(
      4,
      'Revisa y crea',
      'Al crear, el curso queda registrado y puedes seguir editándolo desde las pestañas Cursos, Ediciones y Flyers.',
      `<dl class="summary-grid wz-summary">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      <label class="checkbox-field"><input type="checkbox" name="publish" ${canPublish && w.publish ? 'checked' : ''} ${canPublish ? '' : 'disabled'}> Publicar la edición para que se pueda vender</label>
      ${canPublish ? '' : '<p class="crm-hint">Para publicar hace falta una fecha de inicio futura. La edición se guardará como borrador.</p>'}
      ${w.file ? `<label class="checkbox-field"><input type="checkbox" name="reviewed" required> Revisé que la imagen coincide con la fecha, el precio y la edición.</label>${canApprove() ? `<label class="checkbox-field"><input type="checkbox" name="approve" ${w.approve ? 'checked' : ''}> Aprobar la imagen para poder enviarla a clientes</label>` : '<p class="crm-hint">La imagen quedará como borrador hasta que alguien con permiso de aprobación la apruebe.</p>'}` : ''}`,
      'Crear curso',
    );
  }

  function collect(form) {
    const f = Object.fromEntries(new FormData(form)),
      n = Number(form.dataset.step);
    if (n === 1) {
      w.brandId = f.brandId || w.brandId;
      w.title = (f.title || '').trim();
      w.syllabus = (f.syllabus || '').trim();
    }
    if (n === 2) for (const k of Object.keys(w.ed)) if (k in f) w.ed[k] = typeof f[k] === 'string' ? f[k].trim() : f[k];
    if (n === 4) {
      w.publish = form.querySelector('[name=publish]')?.checked ?? false;
      w.approve = form.querySelector('[name=approve]')?.checked ?? false;
    }
  }
  const toBase64 = file =>
    new Promise((done, fail) => {
      const r = new FileReader();
      r.onload = () => done(String(r.result).split(',')[1]);
      r.onerror = fail;
      r.readAsDataURL(file);
    });

  async function create(form) {
    collect(form);
    const e = w.ed,
      progress = m => {
        const x = $('#wz-feedback');
        if (x) x.textContent = m;
      };
    let created = '';
    form.querySelectorAll('button,input').forEach(x => {
      x.disabled = true;
    });
    try {
      const start = instant(e.startsAt, e.timezone),
        end = instant(e.endsAt, e.timezone);
      // Cada paso se anota en w.run: si algo falla, «Crear curso» continúa donde se quedó y no duplica el curso.
      const r = w.run;
      if (!r.courseId) {
        progress('Creando el curso…');
        const c = await api('/api/catalogue/courses', {
          method: 'POST',
          body: { brandId: w.brandId, title: w.title, syllabus: w.syllabus, active: true },
        });
        r.courseId = c.item.id;
      }
      created = 'El curso quedó creado';
      const status = w.publish && start !== null && start > Date.now() ? 'published' : 'draft';
      if (!r.editionId) {
        const d = await load();
        const ed = d.editions.find(x => x.course_id === r.courseId);
        if (!ed) throw Error('No se encontró la edición inicial del curso.');
        progress('Guardando la edición…');
        const saved = await api('/api/catalogue/editions/' + ed.id, {
          method: 'PATCH',
          body: {
            expectedRevision: ed.revision,
            name: e.name,
            startsAt: start,
            endsAt: end,
            timezone: e.timezone,
            instructor: e.instructor,
            modality: e.modality,
            currency: e.currency,
            location: e.location,
            capacity: e.capacity,
            availableSeats: e.capacity,
            infoUrl: '',
            price: e.price,
            sessionPrice: e.sessionPrice,
            status,
          },
        });
        r.editionId = saved.item.id;
      }
      created = 'El curso y su edición quedaron creados';
      let flyerState = '';
      if (w.file) {
        if (!r.fileId) {
          progress('Subiendo la imagen…');
          r.fileId = (
            await api('/api/catalogue/files', {
              method: 'POST',
              body: {
                brandId: w.brandId,
                file: { name: w.file.name, type: w.file.type, base64: await toBase64(w.file) },
              },
            })
          ).id;
        }
        if (!r.flyer) {
          const fl = await api('/api/catalogue/flyers', {
            method: 'POST',
            body: {
              title: 'Imagen · ' + w.title,
              editionId: r.editionId,
              promotionId: '',
              channel: 'all',
              expiresAt: null,
              fileId: r.fileId,
            },
          });
          r.flyer = fl.item;
        }
        created = 'El curso, su edición y la imagen (en borrador) quedaron creados';
        if (w.approve && canApprove()) {
          if (!r.approved) {
            progress('Aprobando la imagen…');
            await api('/api/catalogue/flyers/' + r.flyer.id + '/approve', {
              method: 'POST',
              body: { expectedRevision: r.flyer.revision },
            });
            r.approved = true;
          }
          flyerState = 'aprobada';
        } else flyerState = 'en borrador';
      }
      await render();
      showModal(
        'Curso creado',
        `${bar(5)}<div class="wz-done"><h3 class="wz-title">${esc(w.title)}</h3><ul class="wz-result"><li>✓ Curso creado</li><li>✓ Edición «${esc(e.name)}» ${status === 'published' ? 'publicada' : 'guardada como borrador'}</li>${w.file ? `<li>✓ Imagen ${flyerState}</li>` : '<li>· Sin imagen: agrégala desde la ficha del curso cuando la tengas</li>'}</ul><p class="crm-hint">${status === 'published' ? 'Ya se puede ofrecer a clientes y cobrar si Pagos está encendido en la marca.' : 'Para que se pueda vender, publica la edición con una fecha futura desde la pestaña Ediciones.'}</p><div class="actions"><button type="button" class="btn primary" data-action="cat-wz-view">Ver mis cursos</button><button type="button" class="btn" data-action="cat-wizard">Crear otro curso</button></div></div>`,
      );
    } catch (error) {
      form.querySelectorAll('button,input').forEach(x => {
        x.disabled = false;
      });
      const box = $('#wz-feedback');
      if (box) {
        box.textContent = '';
        const m = document.createElement('div');
        m.className = 'form-error';
        m.textContent =
          error.message +
          (created
            ? ' ' +
              created +
              '. Puedes pulsar «Crear curso» otra vez para continuar sin duplicarlo, o completar lo que falta desde las pestañas Ediciones y Flyers.'
            : '');
        box.append(m);
      }
      if (created) await render().catch(() => {});
    }
  }

  async function submit(form, input) {
    const n = Number(form.dataset.step);
    if (n === 4) {
      await create(form);
      return true;
    }
    if (n === 2 && !safeZone(input.timezone)) {
      $('#wz-feedback').innerHTML =
        '<div class="form-error">Zona horaria no válida. Usa una como America/Mexico_City.</div>';
      return true;
    }
    if (n === 2) {
      try {
        instant(input.startsAt, input.timezone);
        instant(input.endsAt, input.timezone);
      } catch (e) {
        $('#wz-feedback').innerHTML = '<div class="form-error"></div>';
        $('#wz-feedback .form-error').textContent = e.message;
        return true;
      }
      if (input.endsAt && input.startsAt && input.endsAt <= input.startsAt) {
        $('#wz-feedback').innerHTML = '<div class="form-error">El final debe ser posterior al inicio.</div>';
        return true;
      }
    }
    if (n === 2) {
      const price = Number(input.price),
        session = input.sessionPrice === '' ? null : Number(input.sessionPrice),
        fail = m => {
          const x = $('#wz-feedback');
          x.textContent = '';
          const d = document.createElement('div');
          d.className = 'form-error';
          d.textContent = m;
          x.append(d);
          return true;
        };
      if (!(price >= 0)) return fail('Escribe el precio regular.');
      if (session !== null && !(session >= 0 && session <= price))
        return fail('El precio por sesión no puede ser mayor que el precio regular.');
      if (input.capacity !== '' && !(Number(input.capacity) >= 1)) return fail('El cupo debe ser de al menos 1.');
    }
    collect(form);
    show(n + 1);
    return true;
  }
  function change(target) {
    if (target.id !== 'wz-file') return false;
    const f = target.files[0],
      err = $('#wz-file-error');
    err.textContent = '';
    if (!f) return true;
    if (!TYPES.includes(f.type)) {
      err.innerHTML = '<div class="form-error">Ese formato no se admite. Usa PNG, JPG, WEBP, GIF o PDF.</div>';
      target.value = '';
      return true;
    }
    if (f.size > 4 * 1024 * 1024) {
      err.innerHTML = '<div class="form-error">Pesa más de 4 MB. Comprímela o elige otra.</div>';
      target.value = '';
      return true;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = f.type.startsWith('image/') ? URL.createObjectURL(f) : '';
    w.file = f;
    $('#wz-preview').innerHTML = previewHtml();
    icons();
    const b = $('#cat-wiz-form .btn.primary');
    if (b) b.textContent = 'Siguiente';
    return true;
  }
  async function action(name, el) {
    if (name === 'cat-wizard') {
      if (!state.brands.length) return (toast('Primero crea una marca.'), true);
      w = fresh();
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = '';
      }
      await load();
      show(1);
      return true;
    }
    if (!w) return false;
    if (name === 'cat-wz-back') {
      const f = $('#cat-wiz-form');
      if (f) collect(f);
      show(Math.max(1, w.step - 1));
      return true;
    }
    if (name === 'cat-wz-view') {
      document.querySelector('dialog')?.close();
      return true;
    }
    return false;
  }
  return { action, submit, change };
};
