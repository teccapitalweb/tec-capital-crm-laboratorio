// «Preparar marca»: lista de verificación por marca que junta, en una sola lectura, lo que hace falta para que una marca
// funcione de punta a punta (catálogo, equipo, conocimiento, automatización) y los extras que se encienden aparte (pagos,
// coordinación, certificados, campañas, canal). Sólo LEE: no cambia nada, no toca configuración ni conversaciones. Cada paso
// dice dónde se arregla (vista y pestaña del CRM). Sólo administración; respeta el alcance por marca de crm.brandsFor.
const fail = (status, message) => Object.assign(new Error(message), { status });

// Los pasos que trae esta lista, en su orden. Un módulo no puede registrar otro con el mismo id.
export const BUILT_IN_STEPS = Object.freeze([
  'course',
  'edition',
  'flyer',
  'knowledge',
  'team',
  'routing',
  'away',
  'automation',
  'replies',
  'channel',
  'payments',
  'coordination',
  'certificates',
  'campaigns',
]);
const STEP_ID = /^[a-z][a-z0-9-]{1,40}$/;
const PLACE = /^[a-z][a-z0-9-]{1,30}$/;
const words = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function createReadiness({ db, crm, json, now = Date.now, log = console }) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const count = (sql, ...args) => Number(one(sql, ...args)?.n || 0);

  // Pasos por función: un módulo nuevo añade aquí el suyo en lugar de editar la lista de forBrand(). Se muestran
  // después de los de siempre, en el grupo que digan. `check` recibe la marca ({ id, name }), es síncrona y sólo lee.
  //   readiness.register({
  //     id: 'audiencia', group: 'Extras', title: 'Tiene una audiencia lista', required: false,
  //     view: 'difusiones', label: 'Ir a Difusiones',
  //     check: brand => ({ done: total(brand.id) > 0, detail: 'Sin audiencias no hay a quién enviar una difusión.' }),
  //   });
  const registered = [];
  function register(step) {
    if (step === null || typeof step !== 'object' || Array.isArray(step))
      throw fail(400, 'readiness.register espera un paso { id, group, title, view, label, check }.');
    const { id, group, title, required = false, view, tab, label, check } = step;
    if (typeof id !== 'string' || !STEP_ID.test(id))
      throw fail(400, 'Paso de preparación no válido: el id va en minúsculas, con números y guiones.');
    if (BUILT_IN_STEPS.includes(id) || registered.some(s => s.id === id))
      throw fail(409, 'Paso de preparación repetido: ' + id);
    if (!words(group, 30) || !words(title, 120) || !words(label, 40))
      throw fail(400, 'El paso ' + id + ' necesita grupo, título y el texto de su botón.');
    if (
      typeof view !== 'string' ||
      !PLACE.test(view) ||
      (tab !== undefined && (typeof tab !== 'string' || !PLACE.test(tab)))
    )
      throw fail(400, 'El paso ' + id + ' necesita la vista (y, si aplica, la pestaña) donde se arregla.');
    if (typeof required !== 'boolean')
      throw fail(400, 'El paso ' + id + ' dice si es esencial con required: true o false.');
    if (typeof check !== 'function') throw fail(400, 'El paso ' + id + ' necesita check(marca).');
    registered.push({ id, group: group.trim(), title: title.trim(), required, view, tab, label: label.trim(), check });
    return id;
  }
  // Si la función de un paso registrado falla, ese paso queda pendiente y los demás se siguen viendo.
  function evaluate(step, b) {
    let result = null;
    try {
      result = step.check(Object.freeze({ id: b.id, name: b.name }));
      if (typeof result?.then === 'function') {
        result.then(null, () => {});
        throw new Error('check debe ser síncrona');
      }
    } catch (e) {
      log.error('Readiness step failed:', step.id, e?.name, String(e?.message || '').slice(0, 200));
      result = null;
    }
    const done = result?.done === true,
      detail = typeof result?.detail === 'string' ? result.detail.trim().slice(0, 300) : '';
    return {
      id: step.id,
      group: step.group,
      title: step.title,
      done,
      required: step.required,
      detail: detail || (!result ? 'No se pudo revisar este paso.' : done ? 'Listo.' : 'Pendiente.'),
      view: step.view,
      ...(step.tab ? { tab: step.tab } : {}),
      label: step.label,
    };
  }

  function forBrand(b) {
    const t = now();
    const courses = count('SELECT COUNT(*) n FROM courses WHERE brand_id=? AND active=1', b.id);
    const editions = count(
      "SELECT COUNT(*) n FROM editions e JOIN courses c ON c.id=e.course_id WHERE e.brand_id=? AND c.active=1 AND e.status='published' AND (e.starts_at IS NULL OR e.starts_at>?)",
      b.id,
      t,
    );
    const flyers = count("SELECT COUNT(*) n FROM flyers WHERE brand_id=? AND status='approved'", b.id);
    const knowledge = count("SELECT COUNT(*) n FROM knowledge_entries WHERE brand_id=? AND status='approved'", b.id);
    const team = count(
      "SELECT COUNT(*) n FROM brand_members m JOIN users u ON u.id=m.user_id WHERE m.brand_id=? AND u.role='agent' AND COALESCE(u.disabled,0)=0",
      b.id,
    );
    const ops = one('SELECT routing_enabled,sla_enabled,member_ids FROM operation_settings WHERE brand_id=?', b.id);
    const away = Boolean(
      one(
        "SELECT 1 x FROM event_templates e JOIN content_templates t ON t.id=e.template_id WHERE e.brand_id=? AND e.event='away_hours' AND e.enabled=1 AND t.status='approved'",
        b.id,
      ),
    );
    const automation = one('SELECT enabled FROM automation_settings WHERE brand_id=?', b.id)?.enabled === 1;
    const replies = one('SELECT mode FROM reply_settings WHERE brand_id=?', b.id)?.mode || 'templates';
    const channel = one('SELECT enabled FROM channel_settings WHERE brand_id=?', b.id)?.enabled === 1;
    const payments = one('SELECT enabled FROM payment_settings WHERE brand_id=?', b.id)?.enabled === 1;
    const coordination = one('SELECT enabled FROM coordination_settings WHERE brand_id=?', b.id)?.enabled === 1;
    const cert = one('SELECT auto_issue,signer_name FROM certificate_settings WHERE brand_id=?', b.id);
    const campaigns = one('SELECT enabled FROM campaign_settings WHERE brand_id=?', b.id)?.enabled === 1;
    let members = [];
    try {
      members = JSON.parse(ops?.member_ids || '[]');
    } catch {}
    const routing = ops?.routing_enabled === 1 && members.length > 0;

    // required=true: indispensable para atender y vender; false: extra que se enciende cuando hace falta.
    const steps = [
      {
        id: 'course',
        group: 'Catálogo',
        title: 'Tiene al menos un curso activo',
        done: courses > 0,
        required: true,
        detail: courses
          ? `${courses} curso${courses === 1 ? '' : 's'} activo${courses === 1 ? '' : 's'}.`
          : 'Sin cursos, el cliente no tiene qué elegir. Usa «Nuevo curso» en el Catálogo.',
        view: 'courses',
        label: 'Ir al Catálogo',
      },
      {
        id: 'edition',
        group: 'Catálogo',
        title: 'Tiene una edición publicada con fecha futura',
        done: editions > 0,
        required: true,
        detail: editions
          ? `${editions} edición${editions === 1 ? '' : 'es'} vigente${editions === 1 ? '' : 's'} para vender.`
          : 'El precio, el cupo y la fecha que se le dicen al cliente salen de una edición publicada.',
        view: 'courses',
        label: 'Revisar ediciones',
      },
      {
        id: 'flyer',
        group: 'Catálogo',
        title: 'Tiene una imagen aprobada para enviar',
        done: flyers > 0,
        required: false,
        detail: flyers
          ? `${flyers} imagen${flyers === 1 ? '' : 'es'} aprobada${flyers === 1 ? '' : 's'}.`
          : 'Sin imagen aprobada, el chat sólo manda texto. Se agrega desde la ficha del curso.',
        view: 'courses',
        label: 'Agregar imagen',
      },
      {
        id: 'knowledge',
        group: 'Atención',
        title: 'Tiene respuestas aprobadas en Conocimiento',
        done: knowledge > 0,
        required: true,
        detail: knowledge
          ? `${knowledge} respuesta${knowledge === 1 ? '' : 's'} aprobada${knowledge === 1 ? '' : 's'}: la base de las respuestas automáticas.`
          : 'Las respuestas automáticas sólo usan lo que está aprobado aquí. Sin nada, todo pasa a una persona.',
        view: 'courses',
        label: 'Escribir conocimiento',
      },
      {
        id: 'team',
        group: 'Atención',
        title: 'Tiene asesores asignados',
        done: team > 0,
        required: true,
        detail: team
          ? `${team} asesor${team === 1 ? '' : 'es'} con acceso a la marca.`
          : 'Sin asesores, nadie atiende los chats que el sistema no resuelva. Invita a alguien en «Equipo y accesos».',
        view: 'team',
        label: 'Invitar al equipo',
      },
      {
        id: 'routing',
        group: 'Atención',
        title: 'Reparto de chats y horarios configurados',
        done: routing,
        required: false,
        detail: routing
          ? 'Los chats nuevos se reparten entre ' +
            members.length +
            ' persona' +
            (members.length === 1 ? '' : 's') +
            '.'
          : 'Define horario de atención y quién recibe los chats nuevos.',
        view: 'operations',
        tab: 'settings',
        label: 'Configurar horarios',
      },
      {
        id: 'away',
        group: 'Atención',
        title: 'Mensaje de fuera de horario configurado',
        done: away,
        required: false,
        detail: away
          ? 'Si alguien escribe con la marca cerrada, recibe un aviso con la hora de apertura (una vez cada 12 horas).'
          : 'Sin él, quien escribe de noche o en festivo no sabe cuándo le responderán. Se crea una plantilla «Fuera de horario» y se asigna en Contenido → Eventos.',
        view: 'courses',
        label: 'Ir a Contenido',
      },
      {
        id: 'automation',
        group: 'Automatización',
        title: 'Automatización de la marca encendida',
        done: automation,
        required: true,
        detail: automation
          ? 'Los seguimientos programados están activos.'
          : 'Sin ella no se programa ningún seguimiento, ni recetas ni campañas. Se enciende por marca.',
        view: 'operations',
        tab: 'recipes',
        label: 'Ir a Seguimientos',
      },
      {
        id: 'replies',
        group: 'Automatización',
        title: 'Respuestas automáticas en modo sugerir o autónomo',
        done: replies === 'suggest' || replies === 'autonomous',
        required: false,
        detail:
          replies === 'autonomous'
            ? 'Responde sola con lo aprobado.'
            : replies === 'suggest'
              ? 'Prepara una sugerencia y una persona decide.'
              : replies === 'off'
                ? 'Apagadas.'
                : 'Sólo plantillas, que es el comportamiento de siempre.',
        view: 'operations',
        tab: 'recipes',
        label: 'Elegir el modo',
      },
      {
        id: 'channel',
        group: 'Extras',
        title: 'Canal simulado activo (estados de entrega y ventana de 24 h)',
        done: channel,
        required: false,
        detail: channel ? 'Activo.' : 'Útil para ensayar como será con WhatsApp real.',
        view: 'operations',
        tab: 'recipes',
        label: 'Ir a Seguimientos',
      },
      {
        id: 'payments',
        group: 'Extras',
        title: 'Pagos activos (botón Cobrar y pedidos)',
        done: payments,
        required: false,
        detail: payments
          ? 'Se pueden crear pedidos y enlaces de pago de prueba.'
          : 'Apagado: no hay botón Cobrar. Todo es simulado, no se cobra nada.',
        view: 'operations',
        tab: 'payments',
        label: 'Ir a Pagos',
      },
      {
        id: 'coordination',
        group: 'Extras',
        title: 'Coordinación de aperturas activa',
        done: coordination,
        required: false,
        detail: coordination
          ? 'Las aperturas se gestionan con la automatización.'
          : 'Las aperturas de grupo se llevan a mano.',
        view: 'operations',
        tab: 'coordination',
        label: 'Ir a Coordinación',
      },
      {
        id: 'certificates',
        group: 'Extras',
        title: 'Certificados con firma y emisión configuradas',
        done: Boolean(cert && (cert.auto_issue === 1 || String(cert.signer_name || '').trim())),
        required: false,
        detail:
          cert && (cert.auto_issue === 1 || String(cert.signer_name || '').trim())
            ? 'Hay configuración de certificados.'
            : 'Sólo emisión manual y sin firma.',
        view: 'operations',
        tab: 'certificates',
        label: 'Ir a Certificados',
      },
      {
        id: 'campaigns',
        group: 'Extras',
        title: 'Campañas encendidas',
        done: campaigns,
        required: false,
        detail: campaigns
          ? automation
            ? 'Se pueden programar envíos segmentados.'
            : 'Encendidas, pero sin la automatización de la marca no se envía nada.'
          : 'No se puede programar ni enviar una campaña.',
        view: 'operations',
        tab: 'campaigns',
        label: 'Ir a Campañas',
      },
    ];
    for (const extra of registered) steps.push(evaluate(extra, b));
    const must = steps.filter(s => s.required);
    const next = must.find(s => !s.done) || steps.find(s => !s.done) || null;
    return {
      id: b.id,
      name: b.name,
      essentials: { done: must.filter(s => s.done).length, total: must.length },
      extras: { done: steps.filter(s => !s.required && s.done).length, total: steps.filter(s => !s.required).length },
      ready: must.every(s => s.done),
      nextStepId: next?.id || null,
      steps,
    };
  }

  function handle(req, res, path, user) {
    if (path !== '/api/readiness') return false;
    if (req.method !== 'GET') throw fail(405, 'Método no permitido.');
    const u = one('SELECT role,disabled FROM users WHERE id=?', user.id);
    if (!u || u.disabled || u.role !== 'admin') throw fail(403, 'La preparación de marcas la revisa un administrador.');
    json(res, 200, { brands: crm.brandsFor(user).map(forBrand), checkedAt: now() });
    return true;
  }
  return { handle, forBrand, register };
}
