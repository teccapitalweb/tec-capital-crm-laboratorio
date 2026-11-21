// La lista CERRADA de acciones que el asistente puede proponer (docs/PLAN_MCP_CLAUDE.md, «Propuestas que aprueba una
// persona»). Sólo acciones reversibles desde su propia pantalla, que no escriben a nadie en el momento de aprobarlas:
// publicar, activar o aprobar algo que ya está armado, y una sola de retiro, archivar un curso (pone el curso inactivo,
// no borra nada y se reactiva en el Catálogo), que avisa con datos de la base de lo que deja de ofrecerse.
// Lo que no está aquí no se puede proponer.
//
// Fuera, a propósito: enviar o programar difusiones, enviar plantillas a aprobación de Meta, todo lo de pagos (nunca se
// confirma un pago desde el asistente), borrar, archivar cualquier otra cosa, contactos, mensajes a clientes, llaves,
// usuarios y permisos.
//
// `batchOrder` (0 primero; 1 si no lo dice) es el orden en que la pantalla aprueba un lote: primero se publican las
// aperturas, luego lo demás, después las imágenes (se ligan a la apertura ya publicada) y al final los retiros.
//
// Cada acción dice: qué entidad toca y qué permiso de borradores del conector la cubre; qué permiso de la PERSONA que
// aprueba hace falta (el mismo que pide su pantalla; la ruta lo vuelve a comprobar); qué pasará al aprobarla; cómo se
// revisa si tiene sentido (check, síncrono, con los datos de la base) y la ruta del módulo que la ejecuta (request), la
// misma que pulsa el botón de su pantalla, con la revisión guardada al proponer como expectedRevision.
//
// Lo que la entidad le dirá a los clientes (los mensajes de un recorrido, los pasos de una secuencia, lo que hace una
// regla) sale en `sends` (./preview.mjs), recalculado desde la base: esos textos pudo escribirlos el asistente.
import { flowSends, plain, ruleSends, sendsOf, sequenceSends } from './preview.mjs';

const DRAFTS = 'automation_drafts';
const CONFIG = 'config_drafts';

// El catálogo guarda la apertura completa y la normaliza al guardar (recorta y quita espacios, y deja de marcarla como
// apertura del catálogo anterior). Publicar desde una propuesta no debe cambiar nada más que el estado: si algún dato
// quedaría distinto, no se aprueba desde aquí (se dice cuál) y se corrige en el Catálogo.
const same = (v, n) => typeof v === 'string' && v === v.trim().slice(0, n);
export function editionRoundTrip(e) {
  const out = [];
  if (!same(e.name, 120)) out.push('nombre');
  if (!same(e.instructor, 120)) out.push('docente');
  if (!same(e.location, 250)) out.push('lugar');
  if (!same(e.info_url, 1000)) out.push('enlace de información');
  if (!same(e.timezone, 80)) out.push('zona horaria');
  if (e.legacy) out.push('marca de apertura del catálogo anterior');
  return out;
}

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
const EDITION_STATUS = { draft: 'En borrador', published: 'Publicada', archived: 'Archivada' };
// El `binding` con que el catálogo liga una imagen a los datos de su curso y su apertura (catalogue.mjs, binding()).
const bindingOf = e => JSON.stringify({ course: e.course_version, edition: e.edition_revision, promotion: null });
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
    check(e, ctx) {
      const problems = [];
      if (e.status === 'archived') problems.push('El recorrido está archivado.');
      // lo que se publicaría es el borrador actual
      return { problems, warnings: [], details: [], sends: flowSends(e.draft, ctx.names) };
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
      // lo que atenderá es la versión publicada (no el borrador)
      return {
        problems,
        warnings,
        details: e.published_version === null ? [] : [['Versión que atenderá', 'Versión ' + e.published_version]],
        sends: e.published_version === null ? null : flowSends(ctx.versionGraph(e.id, e.published_version), ctx.names),
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
      return { problems, warnings, details: [['Pasos', String(n)]], sends: sequenceSends(e.steps, ctx.names) };
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
      return { problems, warnings, details: [], sends: ruleSends(e.definition, ctx.names) };
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
    batchOrder: 0,
    effect:
      'La apertura queda a la venta: el asistente la ofrece a los clientes con estos datos. Aprobar sólo cambia su estado: no cambia su precio ni su cupo, así que publicarla no genera por sí mismo avisos de precio o cupo ni eventos de webhooks. Desde ese momento, cada cambio de precio o de cupo de esta apertura sí avisa al equipo y sale como evento a los destinos de webhooks configurados de la marca. Se puede devolver a borrador en el Catálogo.',
    name: e => e.course_title + ' · ' + e.name,
    check(e, ctx) {
      const problems = [];
      if (e.status === 'published') problems.push('La apertura ya está publicada.');
      else if (e.status === 'archived') problems.push('La apertura está archivada.');
      if (!e.course_active) problems.push('El curso está archivado.');
      if ((!e.legacy && e.starts_at === null) || (e.starts_at !== null && e.starts_at <= ctx.now))
        problems.push('Para publicar, la apertura necesita una fecha de inicio futura.');
      const changes = editionRoundTrip(e);
      if (changes.length)
        problems.push(
          `Publicarla desde aquí cambiaría además: ${changes.join(', ')}. Ábrela y guárdala en el Catálogo antes de aprobar.`,
        );
      return {
        problems,
        warnings: [],
        details: [
          ['Curso', plain(e.course_title, 180)],
          // lo que el asistente le dice a quien pregunta por el temario (recortado aquí; completo en el Catálogo)
          ['Temario', plain(e.course_syllabus, 300) || 'Sin temario'],
          ['Apertura', plain(e.name, 120)],
          ['Inicio', when(e.starts_at, e.timezone)],
          ['Fin', when(e.ends_at, e.timezone)],
          ['Precio', money(e.price_cents, e.currency)],
          ...(e.session_price_cents === null || e.session_price_cents === undefined
            ? []
            : [['Precio por sesión', money(e.session_price_cents, e.currency)]]),
          ['Cupo', e.capacity === null ? 'Sin límite' : `${e.available_seats ?? e.capacity} de ${e.capacity}`],
          ['Modalidad', MODALITY[e.modality] || e.modality],
          ['Docente', plain(e.instructor, 120) || 'Por confirmar'],
          ...(e.location ? [['Lugar', plain(e.location, 250)]] : []),
          ...(e.info_url ? [['Enlace de información', plain(e.info_url, 300)]] : []),
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
    label: 'Encender la entrega automática de accesos',
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
      return {
        problems,
        warnings,
        details: [],
        sends: sendsOf([{ label: 'Mensaje que recibirá quien pague', value: e.body, max: 4000 }]),
      };
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
          ['Promoción', plain(e.name, 120)],
          ['Apertura', plain(`${e.course_title} · ${e.edition_name}`, 250)],
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
      return {
        problems,
        warnings: [],
        details: [],
        sends: sendsOf([{ label: 'Texto', value: e.body, max: 4000 }]),
      };
    },
    request: (e, revision) => [
      'catalogue',
      'POST',
      `/api/catalogue/templates/${e.id}/approve`,
      { expectedRevision: revision },
    ],
  },
  aprobar_imagen: {
    entity: 'flyer',
    scope: CONFIG,
    noun: 'imagen',
    label: 'Aprobar la imagen del curso',
    permission: 'content',
    screen: { view: 'courses', label: 'Catálogo' },
    // En un lote va después de publicar las aperturas: la imagen se liga a los datos de su apertura ya publicada.
    batchOrder: 2,
    effect:
      'La imagen queda aprobada para esta apertura: el asistente y el equipo la envían como imagen del curso mientras la apertura esté a la venta y sus datos no cambien. Si la apertura cambió desde que se subió la imagen, al aprobar se vuelve a ligar a los datos que ves aquí. Se puede archivar en el Catálogo.',
    name: e => e.course_title + ' · ' + e.edition_name,
    check(e, ctx) {
      const problems = [];
      const warnings = [];
      if (e.status === 'approved') problems.push('La imagen ya está aprobada.');
      else if (e.status === 'archived') problems.push('La imagen está archivada.');
      if (!e.course_active) problems.push('El curso está archivado.');
      if (e.edition_status === 'archived') problems.push('La apertura está archivada.');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(e.mime))
        problems.push('Desde aquí sólo se aprueba una imagen JPEG, PNG o WebP.');
      if (e.builtin_id) problems.push('Es un arte de demostración: se aprueba en el Catálogo.');
      if (e.promotion_id) problems.push('La imagen va ligada a una promoción: apruébala en el Catálogo.');
      if (e.expires_at !== null && e.expires_at <= ctx.now) problems.push('La imagen ya venció.');
      // Una imagen aprobada en una apertura sin publicar dejaría de valer al publicarla (cambia su revisión). Al
      // proponer, o si hay una propuesta pendiente de publicarla (se aprueba antes en el mismo lote), es un aviso; al
      // aprobar, un impedimento.
      if (e.edition_status === 'draft') {
        const later = ctx.mode === 'propose' || (ctx.mode === 'view' && ctx.pendingPublish(e.edition_id));
        (later ? warnings : problems).push(
          later
            ? 'La apertura todavía no está publicada: la imagen se aprueba después de publicarla (en un lote se publica primero).'
            : 'Publica primero la apertura (si hay una propuesta para publicarla, apruébala antes).',
        );
      }
      if (e.binding !== bindingOf(e) && e.edition_status === 'published')
        warnings.push(
          'La apertura cambió desde que se subió la imagen: al aprobar se vuelve a ligar a los datos actuales de la apertura.',
        );
      return {
        problems,
        warnings,
        details: [
          ['Curso', plain(e.course_title, 180)],
          ['Apertura', plain(e.edition_name, 120)],
          ['Estado de la apertura', EDITION_STATUS[e.edition_status] || e.edition_status],
          ['Formato', e.mime],
        ],
        // La miniatura: la sirve la ruta del catálogo con sesión y alcance por marca (mismo origen).
        image: { url: '/api/library/files/' + e.file_id, alt: 'Imagen propuesta para ' + plain(e.course_title, 120) },
      };
    },
    // Si la apertura cambió desde que se subió (por ejemplo, al publicarla), primero se vuelve a guardar el borrador
    // (lo liga a los datos actuales, como pide el Catálogo) y luego se aprueba; si no, sólo se aprueba.
    steps: (e, revision) =>
      e.binding === bindingOf(e)
        ? [['catalogue', 'POST', `/api/catalogue/flyers/${e.id}/approve`, { expectedRevision: revision }]]
        : [
            [
              'catalogue',
              'PATCH',
              `/api/catalogue/flyers/${e.id}`,
              {
                editionId: e.edition_id,
                fileId: e.file_id,
                title: e.title,
                channel: e.channel,
                expiresAt: e.expires_at,
                expectedRevision: revision,
              },
            ],
            ['catalogue', 'POST', `/api/catalogue/flyers/${e.id}/approve`, { expectedRevision: revision + 1 }],
          ],
  },
  archivar_curso: {
    entity: 'course',
    scope: CONFIG,
    noun: 'curso',
    label: 'Archivar el curso',
    permission: 'catalogue',
    screen: { view: 'courses', label: 'Catálogo' },
    batchOrder: 3,
    effect:
      'El curso sale del catálogo: el asistente deja de ofrecerlo y sus aperturas dejan de venderse (no se borran). No borra nada ni le escribe a nadie. Se puede reactivar en el Catálogo (editar el curso y marcarlo activo).',
    name: e => e.name,
    check(e, ctx) {
      const problems = [];
      const warnings = [];
      if (!e.active) problems.push('El curso ya está archivado.');
      const u = ctx.courseUsage(e.id);
      if (u.waNumbers.length)
        problems.push(
          `Es el curso por omisión de ${u.waNumbers.length === 1 ? 'un número' : u.waNumbers.length + ' números'} de WhatsApp (${u.waNumbers.map(x => plain(x, 60)).join(', ')}): cámbialo en Conectores antes de archivarlo.`,
        );
      const count = (n, one, many) => (n === 1 ? one : n + ' ' + many);
      if (u.publishedEditions)
        warnings.push(
          `Tiene ${count(u.publishedEditions, 'una apertura publicada', 'aperturas publicadas')}: dejan de venderse.`,
        );
      if (u.liveOrders)
        warnings.push(
          `Tiene ${count(u.liveOrders, 'un pedido sin cerrar', 'pedidos sin cerrar')} (pendiente o en revisión).`,
        );
      if (u.openConversations)
        warnings.push(
          `Tiene ${count(u.openConversations, 'una conversación abierta', 'conversaciones abiertas')}: el asistente dejará de dar sus datos y pasará la conversación a una persona.`,
        );
      if (u.ads) warnings.push(`${count(u.ads, 'Un anuncio lleva', 'anuncios llevan')} a este curso.`);
      if (u.sequences)
        warnings.push(`Lo usa ${count(u.sequences, 'una secuencia encendida', 'secuencias encendidas')}.`);
      if (u.flows) warnings.push(`Lo usa ${count(u.flows, 'un recorrido activo', 'recorridos activos')}.`);
      if (u.rules) warnings.push(`Lo usa ${count(u.rules, 'una regla encendida', 'reglas encendidas')}.`);
      if (u.broadcasts)
        warnings.push(
          `Lo usa ${count(u.broadcasts, 'una difusión programada o enviándose', 'difusiones programadas o enviándose')}.`,
        );
      return {
        problems,
        warnings,
        details: [
          ['Curso', plain(e.name, 180)],
          ['Aperturas', `${u.publishedEditions} publicadas · ${u.draftEditions} en borrador`],
        ],
      };
    },
    request: (e, revision) => [
      'catalogue',
      'POST',
      `/api/catalogue/courses/${e.id}/archive`,
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
  ['catalogue', 'PATCH', new RegExp(`^/api/catalogue/(editions|promotions|flyers)/${ID}$`)],
  ['catalogue', 'POST', new RegExp(`^/api/catalogue/(templates|flyers)/${ID}/approve$`)],
  // el único retiro: archivar un curso (active=0, reversible desde el Catálogo)
  ['catalogue', 'POST', new RegExp(`^/api/catalogue/courses/${ID}/archive$`)],
  ['course-access', 'PUT', new RegExp(`^/api/course-access/editions/${ID}$`)],
]);

export const STATUS = Object.freeze({
  pending: 'Pendiente',
  approving: 'Aprobándose',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  // por el asistente, o sola si la llave o conexión que la propuso ya no está activa (el motivo lo dice)
  withdrawn: 'Retirada',
  expired: 'Vencida',
  stale: 'Obsoleta',
  failed: 'No se pudo aplicar',
});
