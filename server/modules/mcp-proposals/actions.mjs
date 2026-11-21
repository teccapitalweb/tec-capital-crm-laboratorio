// La lista CERRADA de acciones que el asistente puede proponer (docs/PLAN_MCP_CLAUDE.md, «Propuestas que aprueba una
// persona»). Sólo acciones reversibles desde su propia pantalla, que no escriben a nadie en el momento de aprobarlas:
// publicar o activar algo que ya está armado. Lo que no está aquí no se puede proponer.
//
// Fuera, a propósito: enviar o programar difusiones, enviar plantillas a aprobación de Meta, todo lo de pagos (nunca se
// confirma un pago desde el asistente), borrar o archivar, contactos, mensajes a clientes, llaves, usuarios y permisos.
//
// Cada acción dice: qué entidad toca y qué permiso de borradores del conector la cubre; qué permiso de la PERSONA que
// aprueba hace falta (el mismo que pide su pantalla; la ruta lo vuelve a comprobar); qué pasará al aprobarla; cómo se
// revisa si tiene sentido (check, síncrono, con los datos de la base) y la ruta del módulo que la ejecuta (request), la
// misma que pulsa el botón de su pantalla, con la revisión guardada al proponer como expectedRevision.
const DRAFTS = 'automation_drafts';
const CONFIG = 'config_drafts';

const money = (cents, currency) => {
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency || 'MXN' }).format(
      (cents || 0) / 100,
    );
  } catch {
    return String((cents || 0) / 100);
  }
};
const when = (t, zone) => {
  if (t === null || t === undefined) return 'Sin fecha';
  try {
    return (
      new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(t) +
      ' · ' +
      zone
    );
  } catch {
    return new Date(t).toISOString();
  }
};
const MODALITY = { online: 'En línea', in_person: 'Presencial', hybrid: 'Híbrida' };
const steps = raw => {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

export const ACTIONS = Object.freeze({
  publicar_recorrido: {
    entity: 'chatflow',
    scope: DRAFTS,
    noun: 'recorrido',
    label: 'Publicar el recorrido',
    permission: 'automation',
    screen: { view: 'automatizacion', label: 'Automatización' },
    effect:
      'Se guarda una versión nueva con el borrador actual. Si el recorrido ya está activo, atiende con esa versión desde ese momento; si no, sigue sin atender hasta que alguien lo active. Se puede volver a publicar o pausar en Automatización.',
    name: e => e.name,
    check(e) {
      const problems = [];
      if (e.status === 'archived') problems.push('El recorrido está archivado.');
      return { problems, warnings: [], details: [] };
    },
    // Los errores de revisión impiden publicar (los mismos que la pantalla y revisar_recorrido); los avisos se muestran.
    review: { module: 'chatflows', method: 'POST', path: id => `/api/chatflows/${id}/validate`, issues: r => r.issues },
    request: (e, revision) => [
      'chatflows',
      'POST',
      `/api/chatflows/${e.id}/publish`,
      { expectedRevision: revision, note: 'Aprobado desde Propuestas del asistente' },
    ],
  },
  activar_recorrido: {
    entity: 'chatflow',
    scope: DRAFTS,
    noun: 'recorrido',
    label: 'Activar el recorrido',
    permission: 'automation',
    screen: { view: 'automatizacion', label: 'Automatización' },
    effect:
      'El recorrido publicado empieza a atender conversaciones según su inicio. Se puede pausar en cualquier momento en Automatización.',
    name: e => e.name,
    check(e, ctx) {
      const problems = [];
      const warnings = [];
      if (e.status === 'archived') problems.push('El recorrido está archivado.');
      else if (e.status === 'active') problems.push('El recorrido ya está activo.');
      if (e.published_version === null) problems.push('Publica el recorrido antes de activarlo.');
      if (!ctx.automationOn)
        warnings.push('La automatización de la marca está apagada: el recorrido no atenderá hasta encenderla.');
      return {
        problems,
        warnings,
        details: e.published_version === null ? [] : [['Versión que atenderá', 'Versión ' + e.published_version]],
      };
    },
    request: (e, revision) => ['chatflows', 'POST', `/api/chatflows/${e.id}/activate`, { expectedRevision: revision }],
  },
  encender_secuencia: {
    entity: 'sequence',
    scope: DRAFTS,
    noun: 'secuencia',
    label: 'Encender la secuencia',
    permission: 'automation',
    screen: { view: 'secuencias', label: 'Secuencias' },
    effect:
      'La secuencia empieza a inscribir a quien cumpla su inicio desde este momento y le envía sus pasos a su hora. Se puede apagar en Secuencias (apagarla detiene lo pendiente).',
    name: e => e.name,
    check(e, ctx) {
      const problems = [];
      const warnings = [];
      const n = steps(e.steps).length;
      if (e.archived_at) problems.push('La secuencia está archivada.');
      else if (e.enabled) problems.push('La secuencia ya está encendida.');
      if (!n) problems.push('Agrega al menos un paso antes de encenderla.');
      if (!ctx.automationOn)
        warnings.push('La automatización de la marca está apagada: la secuencia no enviará nada hasta encenderla.');
      return { problems, warnings, details: [['Pasos', String(n)]] };
    },
    request: (e, revision) => ['sequences', 'POST', `/api/sequences/${e.id}/enable`, { expectedRevision: revision }],
  },
  activar_regla: {
    entity: 'rule',
    scope: DRAFTS,
    noun: 'regla',
    label: 'Encender la regla',
    permission: 'automation',
    screen: { view: 'reglas', label: 'Reglas' },
    effect:
      'La regla empieza a correr con cada mensaje que coincida, en su lugar de la lista de la marca. Se puede pausar en Reglas.',
    name: e => e.name,
    check(e, ctx) {
      const problems = [];
      const warnings = [];
      if (e.status === 'archived') problems.push('La regla está archivada.');
      else if (e.status === 'active') problems.push('La regla ya está encendida.');
      if (!ctx.automationOn)
        warnings.push('La automatización de la marca está apagada: la regla no correrá hasta encenderla.');
      return { problems, warnings, details: [] };
    },
    // Lo que le falta para poder encenderse (material sin aprobar, recorrido inactivo…), con la misma regla del módulo.
    review: {
      module: 'rules',
      method: 'GET',
      path: id => `/api/rules/${id}`,
      issues: r => ({ errors: r.rule?.issues ?? [], warnings: [] }),
    },
    request: (e, revision) => ['rules', 'POST', `/api/rules/${e.id}/activate`, { expectedRevision: revision }],
  },
  publicar_apertura: {
    entity: 'edition',
    scope: CONFIG,
    noun: 'apertura',
    label: 'Publicar la apertura',
    permission: 'catalogue',
    screen: { view: 'courses', label: 'Catálogo' },
    effect:
      'La apertura queda a la venta: el asistente la ofrece con esta fecha, precio y cupo. Se puede devolver a borrador en el Catálogo.',
    name: e => e.course_title + ' · ' + e.name,
    check(e, ctx) {
      const problems = [];
      if (e.status === 'published') problems.push('La apertura ya está publicada.');
      else if (e.status === 'archived') problems.push('La apertura está archivada.');
      if (!e.course_active) problems.push('El curso está archivado.');
      if ((!e.legacy && e.starts_at === null) || (e.starts_at !== null && e.starts_at <= ctx.now))
        problems.push('Para publicar, la apertura necesita una fecha de inicio futura.');
      return {
        problems,
        warnings: [],
        details: [
          ['Inicio', when(e.starts_at, e.timezone)],
          ['Precio', money(e.price_cents, e.currency)],
          ['Cupo', e.capacity === null ? 'Sin límite' : `${e.available_seats ?? e.capacity} de ${e.capacity}`],
          ['Modalidad', MODALITY[e.modality] || e.modality],
        ],
      };
    },
    // El catálogo guarda la apertura completa: se manda tal como está en la base, sólo con el estado «published».
    request: (e, revision) => [
      'catalogue',
      'PATCH',
      `/api/catalogue/editions/${e.id}`,
      {
        name: e.name,
        startsAt: e.starts_at,
        endsAt: e.ends_at,
        timezone: e.timezone,
        instructor: e.instructor,
        modality: e.modality,
        location: e.location,
        infoUrl: e.info_url || '',
        capacity: e.capacity,
        availableSeats: e.available_seats,
        price: e.price_cents / 100,
        sessionPrice:
          e.session_price_cents === null || e.session_price_cents === undefined ? null : e.session_price_cents / 100,
        currency: e.currency,
        status: 'published',
        expectedRevision: revision,
      },
    ],
  },
  encender_accesos: {
    entity: 'course_access',
    scope: DRAFTS,
    noun: 'entrega de accesos',
    label: 'Encender la entrega automática de accesos de',
    permission: 'access',
    screen: { view: 'accesos', label: 'Accesos' },
    effect:
      'Quien pague esta apertura recibirá solo este mensaje con sus accesos cuando una persona confirme su pago. No envía nada al aprobar y nunca confirma pagos. Se puede apagar en Accesos.',
    name: e => e.course_title + ' · ' + e.edition_name,
    check(e, ctx) {
      const problems = [];
      const warnings = [];
      if (e.edition_status === 'archived' || !e.course_active)
        problems.push('La apertura o su curso están archivados.');
      if (e.enabled) problems.push('La entrega de accesos ya está encendida.');
      problems.push(...ctx.accessProblems(e.body, e));
      if (e.edition_status !== 'published') warnings.push('La apertura todavía no está a la venta.');
      return { problems, warnings, details: [['Mensaje que recibirá quien pague', e.body]] };
    },
    request: (e, revision) => [
      'course-access',
      'PUT',
      `/api/course-access/editions/${e.id}`,
      { enabled: true, expectedRevision: revision },
    ],
  },
  activar_promocion: {
    entity: 'promotion',
    scope: CONFIG,
    noun: 'promoción',
    label: 'Activar la promoción',
    permission: 'catalogue',
    screen: { view: 'courses', label: 'Catálogo' },
    effect:
      'El precio de la promoción vale durante su vigencia para esta apertura: el asistente lo ofrece y se cobra. Se puede archivar en el Catálogo.',
    name: e => `${e.name} (${e.course_title} · ${e.edition_name})`,
    check(e, ctx) {
      const problems = [];
      if (e.status === 'published') problems.push('La promoción ya está activa.');
      else if (e.status === 'archived') problems.push('La promoción está archivada.');
      if (e.edition_status !== 'published') problems.push('Publica primero la apertura de la promoción.');
      if (e.ends_at <= ctx.now) problems.push('La vigencia de la promoción ya terminó.');
      if (e.edition_starts !== null && e.ends_at > e.edition_starts)
        problems.push('La vigencia debe terminar antes de que empiece el curso.');
      if (e.price_cents >= e.edition_price) problems.push('El precio de la promoción debe ser menor al regular.');
      if (ctx.overlap(e)) problems.push('Ya hay una promoción activa que coincide en fechas en esta apertura.');
      return {
        problems,
        warnings: [],
        details: [
          ['Precio', `${money(e.price_cents, e.currency)} (regular ${money(e.edition_price, e.currency)})`],
          ['Vigencia', `${when(e.starts_at, e.timezone)} → ${when(e.ends_at, e.timezone)}`],
        ],
      };
    },
    request: (e, revision) => [
      'catalogue',
      'PATCH',
      `/api/catalogue/promotions/${e.id}`,
      {
        name: e.name,
        price: e.price_cents / 100,
        startsAt: e.starts_at,
        endsAt: e.ends_at,
        status: 'published',
        expectedRevision: revision,
      },
    ],
  },
  publicar_texto: {
    entity: 'content_template',
    scope: CONFIG,
    noun: 'texto',
    label: 'Publicar el texto',
    permission: 'content',
    screen: { view: 'courses', label: 'Catálogo' },
    effect:
      'El texto queda aprobado: el equipo y el asistente lo pueden usar en sus envíos desde ese momento. Se puede archivar en el Catálogo.',
    name: e => e.name,
    check(e) {
      const problems = [];
      if (e.status === 'approved') problems.push('El texto ya está publicado.');
      else if (e.status === 'archived') problems.push('El texto está archivado.');
      return { problems, warnings: [], details: [['Texto', e.body]] };
    },
    request: (e, revision) => [
      'catalogue',
      'POST',
      `/api/catalogue/templates/${e.id}/approve`,
      { expectedRevision: revision },
    ],
  },
});
export const ACTION_KEYS = Object.freeze(Object.keys(ACTIONS));
export const actionOf = key => (typeof key === 'string' && Object.hasOwn(ACTIONS, key) ? ACTIONS[key] : null);

// Las únicas rutas de los módulos que aprobar una propuesta puede tocar (y revisar una, sólo de lectura).
const ID = '[A-Za-z0-9_-]{1,80}';
export const EXEC_ROUTES = Object.freeze([
  ['chatflows', 'POST', new RegExp(`^/api/chatflows/${ID}/(publish|activate|validate)$`)],
  ['sequences', 'POST', new RegExp(`^/api/sequences/${ID}/enable$`)],
  ['rules', 'GET', new RegExp(`^/api/rules/${ID}$`)],
  ['rules', 'POST', new RegExp(`^/api/rules/${ID}/activate$`)],
  ['catalogue', 'PATCH', new RegExp(`^/api/catalogue/(editions|promotions)/${ID}$`)],
  ['catalogue', 'POST', new RegExp(`^/api/catalogue/templates/${ID}/approve$`)],
  ['course-access', 'PUT', new RegExp(`^/api/course-access/editions/${ID}$`)],
]);

export const STATUS = Object.freeze({
  pending: 'Pendiente',
  approving: 'Aprobándose',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  withdrawn: 'Retirada por el asistente',
  expired: 'Vencida',
  stale: 'Obsoleta',
  failed: 'No se pudo aplicar',
});
