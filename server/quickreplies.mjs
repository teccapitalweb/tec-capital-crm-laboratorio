import { randomUUID } from 'node:crypto';

// Respuestas rápidas del chat (Fase 5, bloque 5; docs/PLAN_CHAT_RAPIDO.md). Textos que el equipo inserta en el compositor
// escribiendo «/atajo»: personales (de una persona) o compartidas por marca (las administra administración). Sólo llevan
// variables de conversación (nombre, curso, edición, marca, asesor): los precios, fechas y cupos siguen saliendo de las
// plantillas aprobadas y del catálogo vigente, nunca de un texto escrito a mano. Insertar no envía nada: la persona revisa
// y envía por la ruta normal, que ya respeta la ventana de servicio y el canal.
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const VARIABLES = {
  nombre: 'Nombre de pila del cliente',
  nombre_completo: 'Nombre completo del cliente',
  curso: 'Curso de la conversación',
  edicion: 'Edición de la conversación',
  marca: 'Marca',
  asesor: 'Tu nombre',
};
// Biblioteca de ejemplos para una consultora de cursos: el ciclo completo (saludar, descubrir lo que necesita, informar, objeciones,
// inscripción, pagos, seguimiento, alumnos y cierre). Criterio: tono cercano y profesional, se escucha antes de vender, no se presiona
// y NO se afirma nada que varíe por marca o curso (precios, fechas, cupos, certificados, grabaciones, descuentos, garantías): eso sale
// del catálogo y de las plantillas aprobadas, o se confirma con una persona. Sólo variables de conversación. Las agrega cada persona con
// un clic y las edita a su gusto; test/quickreplies.test.mjs hace cumplir el criterio.
export const STARTER = [
  // Saludar
  {
    group: 'Saludar',
    shortcut: 'hola',
    title: 'Saludo inicial',
    body: 'Hola {{nombre}}, soy {{asesor}} de {{marca}}. ¡Gracias por escribirnos! ¿En qué te puedo ayudar con {{curso}}?',
  },
  {
    group: 'Saludar',
    shortcut: 'buenosdias',
    title: 'Saludo con calidez',
    body: 'Buenos días, {{nombre}}. Soy {{asesor}} de {{marca}}. Qué gusto saludarte; cuéntame, ¿cómo te puedo ayudar con {{curso}}?',
  },
  {
    group: 'Saludar',
    shortcut: 'gracias',
    title: 'Agradecer el interés',
    body: 'Hola {{nombre}}, gracias por tu interés en {{curso}}. Soy {{asesor}} de {{marca}} y con gusto te acompaño.',
  },
  {
    group: 'Saludar',
    shortcut: 'disculpa',
    title: 'Disculpa por la espera',
    body: 'Disculpa la espera, {{nombre}}. Ya estoy contigo; soy {{asesor}} de {{marca}}.',
  },
  // Descubrir lo que necesita (antes de vender)
  {
    group: 'Descubrir',
    shortcut: 'objetivo',
    title: '¿Qué quieres lograr?',
    body: 'Para recomendarte lo mejor, {{nombre}}, cuéntame: ¿qué te gustaría lograr con {{curso}}?',
  },
  {
    group: 'Descubrir',
    shortcut: 'perfil',
    title: 'Conocer su experiencia',
    body: '{{nombre}}, ¿a qué te dedicas o qué experiencia tienes en el tema? Así te explico si {{curso}} es lo que necesitas.',
  },
  {
    group: 'Descubrir',
    shortcut: 'cuando',
    title: '¿Para cuándo lo buscas?',
    body: '¿Cuándo te gustaría empezar, {{nombre}}? Con eso reviso la edición que mejor te acomode.',
  },
  {
    group: 'Descubrir',
    shortcut: 'equipo',
    title: '¿Es para ti o para tu equipo?',
    body: '¿La capacitación es para ti o para otras personas de tu equipo, {{nombre}}? Si son varias, lo vemos juntos.',
  },
  {
    group: 'Descubrir',
    shortcut: 'comonos',
    title: '¿Cómo nos conociste?',
    body: '{{nombre}}, por curiosidad, ¿cómo conociste {{marca}}? Me ayuda a atenderte mejor.',
  },
  // Informar
  {
    group: 'Informar',
    shortcut: 'info',
    title: 'Ofrecer información',
    body: 'Con gusto te cuento todo sobre {{curso}}, {{nombre}}. ¿Prefieres que te comparta el temario, las fechas o cómo inscribirte?',
  },
  {
    group: 'Informar',
    shortcut: 'flyer',
    title: 'Enviar la información del curso',
    body: 'Te comparto la información de {{curso}} para que la veas con calma, {{nombre}}. Cualquier duda me escribes y te ayudo con gusto.',
  },
  {
    group: 'Informar',
    shortcut: 'temario',
    title: 'Invitar a revisar el temario',
    body: 'Revisa con calma el temario de {{curso}}, {{nombre}}. Si algún tema te genera duda, me dices y lo platicamos.',
  },
  {
    group: 'Informar',
    shortcut: 'modalidad',
    title: '¿Cómo prefieres tomarlo?',
    body: '¿Cómo prefieres llevar el curso, {{nombre}}? Con gusto reviso el horario y la modalidad que mejor se adapten a ti.',
  },
  {
    group: 'Informar',
    shortcut: 'espera',
    title: 'Pedir un momento',
    body: 'Dame un momento, {{nombre}}, lo reviso y te respondo enseguida.',
  },
  {
    group: 'Informar',
    shortcut: 'confirmar',
    title: 'Lo confirmo con el equipo',
    body: 'Quiero darte la información correcta, {{nombre}}. Lo confirmo con el equipo de {{marca}} y te respondo por aquí en cuanto lo tenga.',
  },
  {
    group: 'Informar',
    shortcut: 'duda',
    title: 'Revisar antes de responder',
    body: 'Buena pregunta, {{nombre}}. Déjame revisarlo bien para no darte información a medias; te respondo enseguida.',
  },
  {
    group: 'Informar',
    shortcut: 'datos',
    title: 'Pedir datos para inscribirlo',
    body: 'Para continuar con tu inscripción a {{curso}}, {{nombre}}, ¿me compartes tu nombre completo y tu correo electrónico?',
  },
  // Objeciones: se escucha primero, sin presionar
  {
    group: 'Objeciones',
    shortcut: 'caro',
    title: '«Me parece caro»',
    body: 'Te entiendo, {{nombre}}, es una decisión importante. Cuéntame qué te preocupa y revisamos juntos las opciones de pago que sí están disponibles en {{marca}}.',
  },
  {
    group: 'Objeciones',
    shortcut: 'pensarlo',
    title: '«Lo voy a pensar»',
    body: 'Claro, {{nombre}}, tómate tu tiempo. Si te surge cualquier duda mientras decides, aquí estoy. ¿Te parece si te escribo más adelante para saber cómo vas?',
  },
  {
    group: 'Objeciones',
    shortcut: 'tiempo',
    title: '«No tengo tiempo»',
    body: 'Entiendo, {{nombre}}, el tiempo es lo más valioso. Cuéntame cómo es tu semana y reviso si {{curso}} se ajusta a tu ritmo antes de que decidas.',
  },
  {
    group: 'Objeciones',
    shortcut: 'sirve',
    title: '«¿Me sirve este curso?»',
    body: 'Es normal dudar si {{curso}} es para ti, {{nombre}}. Cuéntame tu experiencia y te digo con honestidad si te conviene o si hay otra opción mejor.',
  },
  {
    group: 'Objeciones',
    shortcut: 'confianza',
    title: '«¿Es confiable?»',
    body: 'Haces bien en preguntar, {{nombre}}. Con gusto resuelvo lo que necesites saber de {{marca}} y de {{curso}} para que decidas con tranquilidad.',
  },
  {
    group: 'Objeciones',
    shortcut: 'comparar',
    title: '«Estoy viendo otras opciones»',
    body: 'Qué bien que compares, {{nombre}}. Dime qué otra opción estás viendo y qué es lo más importante para ti, y te ayudo a decidir con claridad.',
  },
  {
    group: 'Objeciones',
    shortcut: 'nointeresa',
    title: '«No me interesa»',
    body: 'Gracias por avisarme, {{nombre}}, lo respeto. Si más adelante te interesa algo de {{marca}}, aquí estaremos. ¡Mucho éxito!',
  },
  // Inscripción
  {
    group: 'Inscripción',
    shortcut: 'inscribir',
    title: 'Invitar a inscribirse',
    body: 'Si ya lo decidiste, {{nombre}}, te ayudo a inscribirte a {{curso}} ahora mismo. Sólo necesito unos datos y te envío tu enlace de pago.',
  },
  {
    group: 'Inscripción',
    shortcut: 'edicion',
    title: 'Confirmar la edición',
    body: 'Antes de continuar, {{nombre}}, confirmo contigo: ¿te inscribo a {{curso}} en la edición {{edicion}}?',
  },
  {
    group: 'Inscripción',
    shortcut: 'listo',
    title: 'Ya tengo tus datos',
    body: '¡Excelente decisión, {{nombre}}! Ya tengo lo necesario para tu inscripción a {{curso}}. En un momento te comparto los siguientes pasos.',
  },
  {
    group: 'Inscripción',
    shortcut: 'factura',
    title: 'Pide factura',
    body: 'Con gusto, {{nombre}}. Confirmo con el equipo de {{marca}} cómo solicitarla y te explico el proceso por aquí.',
  },
  // Pagos
  {
    group: 'Pagos',
    shortcut: 'pagar',
    title: 'Ofrecer el enlace de pago',
    body: 'Para inscribirte a {{curso}} puedo enviarte tu enlace de pago aquí mismo, {{nombre}}. ¿Te lo mando?',
  },
  {
    group: 'Pagos',
    shortcut: 'metodo',
    title: '¿Cómo prefieres pagar?',
    body: '¿Cómo prefieres pagar, {{nombre}}? Dime y te indico los pasos del método disponible que mejor te funcione.',
  },
  {
    group: 'Pagos',
    shortcut: 'pendiente',
    title: 'Recordar un pago pendiente',
    body: 'Hola {{nombre}}, vi que tu pago de {{curso}} sigue pendiente. ¿Tuviste algún problema con el enlace? Si quieres, te ayudo a completarlo.',
  },
  {
    group: 'Pagos',
    shortcut: 'fallo',
    title: 'El pago no pasó',
    body: 'Lamento el inconveniente, {{nombre}}. Cuéntame qué mensaje te apareció y lo revisamos juntos para que puedas completar tu pago sin problema.',
  },
  {
    group: 'Pagos',
    shortcut: 'comprobante',
    title: 'Recibí tu comprobante',
    body: 'Recibí tu comprobante, {{nombre}}. Lo reviso y te confirmo tu inscripción a {{curso}} en cuanto esté validado.',
  },
  {
    group: 'Pagos',
    shortcut: 'pagado',
    title: 'Pago confirmado (úsala sólo si ya lo validaste)',
    body: '¡Listo, {{nombre}}! Tu pago quedó confirmado y ya estás inscrito en {{curso}} ({{edicion}}). Bienvenido a {{marca}}.',
  },
  // Seguimiento
  {
    group: 'Seguimiento',
    shortcut: 'seguimiento',
    title: 'Retomar la conversación',
    body: 'Hola {{nombre}}, ¿pudiste revisar la información de {{curso}}? Si tienes alguna duda, aquí estoy para ayudarte.',
  },
  {
    group: 'Seguimiento',
    shortcut: 'sigues',
    title: '¿Todavía te interesa?',
    body: 'Hola {{nombre}}, te escribo para saber si aún te interesa {{curso}}. Si prefieres que no te escribamos más, dímelo y lo respetamos.',
  },
  {
    group: 'Seguimiento',
    shortcut: 'recordatorio',
    title: 'Recordar lo que quedamos',
    body: 'Hola {{nombre}}, te recuerdo que quedamos de platicar sobre {{curso}}. ¿Sigue siendo buen momento para ti?',
  },
  {
    group: 'Seguimiento',
    shortcut: 'novedades',
    title: 'Avisar que hay novedades',
    body: 'Hola {{nombre}}, soy {{asesor}} de {{marca}}. Hay novedades sobre {{curso}} que creo que te pueden interesar. ¿Te las cuento por aquí?',
  },
  {
    group: 'Seguimiento',
    shortcut: 'ultimo',
    title: 'Último mensaje, sin presionar',
    body: 'Hola {{nombre}}, no quiero insistirte. Si ya no es buen momento para {{curso}}, no hay problema: avísame y dejo de escribirte, o dime cuándo prefieres que retomemos.',
  },
  // Alumnos (después de inscribirse)
  {
    group: 'Alumnos',
    shortcut: 'bienvenido',
    title: 'Bienvenida a un alumno',
    body: '¡Bienvenido a {{curso}}, {{nombre}}! Qué gusto tenerte en {{marca}}. Cualquier duda sobre el acceso o el inicio, escríbeme y te ayudo.',
  },
  {
    group: 'Alumnos',
    shortcut: 'acceso',
    title: 'Ayuda con el acceso',
    body: 'Vamos a resolverlo, {{nombre}}. ¿Me cuentas qué ves en pantalla cuando intentas entrar a {{curso}}? Si puedes, mándame una captura.',
  },
  {
    group: 'Alumnos',
    shortcut: 'opinion',
    title: 'Pedir su opinión',
    body: 'Hola {{nombre}}, ¿cómo te va en {{curso}}? Tu opinión nos ayuda a mejorar; ¿me cuentas qué te ha gustado y qué cambiarías?',
  },
  {
    group: 'Alumnos',
    shortcut: 'constancia',
    title: 'Pregunta por su constancia',
    body: 'Gracias por preguntar, {{nombre}}. Reviso con el equipo de {{marca}} cómo va tu constancia de {{curso}} y te confirmo por aquí.',
  },
  {
    group: 'Alumnos',
    shortcut: 'recomienda',
    title: 'Pedir una recomendación',
    body: 'Me alegra que {{curso}} te esté sirviendo, {{nombre}}. Si conoces a alguien a quien le pueda ayudar, con gusto lo atiendo igual de bien.',
  },
  {
    group: 'Alumnos',
    shortcut: 'siguiente',
    title: 'Ofrecer seguir aprendiendo',
    body: 'Hola {{nombre}}, ¿qué te pareció {{curso}}? Si quieres seguir aprendiendo, con gusto te cuento qué otros cursos de {{marca}} podrían interesarte.',
  },
  // Cerrar
  {
    group: 'Cerrar',
    shortcut: 'dudas',
    title: '¿Te quedó alguna duda?',
    body: '¿Te quedó alguna duda, {{nombre}}? Con gusto te ayudo.',
  },
  {
    group: 'Cerrar',
    shortcut: 'cerrar',
    title: 'Cerrar la conversación',
    body: 'Quedo atento a lo que necesites, {{nombre}}. Voy a cerrar esta conversación por ahora; puedes escribirnos cuando quieras y retomamos sin problema.',
  },
  {
    group: 'Cerrar',
    shortcut: 'despedida',
    title: 'Despedida',
    body: 'Gracias por escribir a {{marca}}, {{nombre}}. Que tengas un excelente día. Soy {{asesor}}; aquí sigo para lo que necesites.',
  },
  {
    group: 'Cerrar',
    shortcut: 'ausente',
    title: 'Fuera de horario (manual)',
    body: 'Hola {{nombre}}, ahora estamos fuera de horario en {{marca}}. Te leo y te respondo en cuanto abramos. Soy {{asesor}}.',
  },
  {
    group: 'Cerrar',
    shortcut: 'error',
    title: 'Reconocer un error',
    body: 'Tienes razón, {{nombre}}, me equivoqué y te pido una disculpa. Ya lo corrijo y te confirmo por aquí.',
  },
];
const SHORTCUT = /^[a-z0-9áéíóúüñ_-]{2,20}$/;
const MAX_PER_OWNER = 100,
  MAX_BODY = 1500;

export function validateBody(body) {
  const matches = [...body.matchAll(/\{\{([^{}]+)\}\}/g)];
  if (
    matches.some(m => !VARIABLES[m[1].trim()]) ||
    body.replace(/\{\{[^{}]+\}\}/g, '').includes('{{') ||
    body.replace(/\{\{[^{}]+\}\}/g, '').includes('}}')
  )
    throw fail(
      400,
      'Usa sólo las variables disponibles (' +
        Object.keys(VARIABLES)
          .map(k => '{{' + k + '}}')
          .join(', ') +
        ') y cierra sus llaves.',
    );
}
export const fill = (body, values) => body.replace(/\{\{([^{}]+)\}\}/g, (_, k) => values[k.trim()] ?? '');

export function createQuickReplies({ db, crm, accessConversation, body, json, audit, now = Date.now }) {
  const staffRow = id => db.prepare('SELECT id,name,role,disabled FROM users WHERE id=?').get(id);
  const requireStaff = user => {
    const u = staffRow(user.id);
    if (!u || u.disabled || !['agent', 'admin'].includes(u.role))
      throw fail(403, 'Las respuestas rápidas son para el equipo de atención.');
    return u;
  };
  const get = id =>
    typeof id === 'string'
      ? db.prepare('SELECT * FROM quick_replies WHERE id=? AND archived_at IS NULL').get(id)
      : null;
  const brandName = id => db.prepare('SELECT name FROM brands WHERE id=?').get(id)?.name || '';
  const view = (r, me) => ({
    id: r.id,
    scope: r.scope,
    brandId: r.brand_id,
    brandName: r.brand_id ? brandName(r.brand_id) : null,
    shortcut: r.shortcut,
    title: r.title,
    body: r.body,
    revision: r.revision,
    uses: r.uses,
    lastUsedAt: r.last_used_at,
    editable: r.scope === 'personal' ? r.user_id === me.id : me.role === 'admin',
  });

  function list(user) {
    const me = requireStaff(user),
      mine = db
        .prepare(
          "SELECT * FROM quick_replies WHERE scope='personal' AND user_id=? AND archived_at IS NULL ORDER BY shortcut",
        )
        .all(me.id);
    const brands = crm.brandsFor(user).map(b => b.id),
      shared = brands.length
        ? db
            .prepare(
              `SELECT * FROM quick_replies WHERE scope='brand' AND brand_id IN (${brands.map(() => '?').join(',')}) AND archived_at IS NULL ORDER BY brand_id,shortcut`,
            )
            .all(...brands)
        : [];
    return {
      quickReplies: [...mine, ...shared].map(r => view(r, me)),
      variables: VARIABLES,
      starter: STARTER,
      brands: crm.brandsFor(user).map(b => ({ id: b.id, name: b.name })),
      canShare: me.role === 'admin',
    };
  }
  function normalize(input, current = null) {
    const shortcut =
      input.shortcut === undefined ? current.shortcut : text(input.shortcut, 60).replace(/^\//, '').toLowerCase();
    if (!SHORTCUT.test(shortcut))
      throw fail(
        400,
        'El atajo usa de 2 a 20 letras, números, guion o guion bajo, sin espacios (por ejemplo «gracias»).',
      );
    const title = input.title === undefined ? current.title : text(input.title, 60);
    if (!title) throw fail(400, 'Ponle un nombre corto a la respuesta.');
    const bodyText = input.body === undefined ? current.body : text(input.body, MAX_BODY + 1);
    if (!bodyText) throw fail(400, 'Escribe el texto de la respuesta.');
    if (bodyText.length > MAX_BODY) throw fail(400, 'La respuesta rápida admite hasta ' + MAX_BODY + ' caracteres.');
    validateBody(bodyText);
    return { shortcut, title, body: bodyText };
  }
  function create(user, input) {
    const me = requireStaff(user),
      scope = input.scope === 'brand' ? 'brand' : 'personal',
      data = normalize(input);
    let brandId = null;
    if (scope === 'brand') {
      if (me.role !== 'admin')
        throw fail(403, 'Las respuestas compartidas de una marca las administra administración.');
      brandId = input.brandId;
      if (typeof brandId !== 'string' || !db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))
        throw fail(404, 'Marca no encontrada.');
      crm.requireBrand(user, brandId);
    }
    const ref = input.clientRef === undefined ? null : text(input.clientRef, 80);
    if (input.clientRef !== undefined && ref.length < 8) throw fail(400, 'Referencia de idempotencia no válida.');
    if (ref) {
      const same = db.prepare('SELECT * FROM quick_replies WHERE client_ref=?').get(ref);
      if (same) {
        if (same.created_by !== me.id) throw fail(409, 'La referencia ya pertenece a otra respuesta.');
        return view(same, me);
      }
    }
    const owner = scope === 'brand' ? ['brand_id', brandId] : ['user_id', me.id];
    if (
      db
        .prepare(`SELECT count(*) n FROM quick_replies WHERE scope=? AND ${owner[0]}=? AND archived_at IS NULL`)
        .get(scope, owner[1]).n >= MAX_PER_OWNER
    )
      throw fail(409, 'Ya tienes el máximo de ' + MAX_PER_OWNER + ' respuestas rápidas. Archiva alguna.');
    if (
      db
        .prepare(`SELECT 1 FROM quick_replies WHERE scope=? AND ${owner[0]}=? AND shortcut=? AND archived_at IS NULL`)
        .get(scope, owner[1], data.shortcut)
    )
      throw fail(409, 'Ya existe una respuesta con el atajo «/' + data.shortcut + '».');
    const id = randomUUID(),
      t = now();
    db.prepare(
      'INSERT INTO quick_replies(id,scope,user_id,brand_id,shortcut,title,body,client_ref,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      scope,
      scope === 'personal' ? me.id : null,
      brandId,
      data.shortcut,
      data.title,
      data.body,
      ref,
      me.id,
      t,
      t,
    );
    return view(get(id), me);
  }
  function editable(user, id) {
    const me = requireStaff(user),
      r = get(id);
    if (!r) throw fail(404, 'Respuesta rápida no encontrada.');
    if (r.scope === 'personal') {
      if (r.user_id !== me.id) throw fail(404, 'Respuesta rápida no encontrada.');
    } else {
      crm.requireBrand(user, r.brand_id);
      if (me.role !== 'admin')
        throw fail(403, 'Las respuestas compartidas de una marca las administra administración.');
    }
    return { me, r };
  }
  function update(user, id, input) {
    const { me, r } = editable(user, id);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== r.revision)
      throw fail(409, 'La respuesta cambió. Recárgala.');
    const data = normalize(input, r),
      owner = r.scope === 'brand' ? ['brand_id', r.brand_id] : ['user_id', r.user_id];
    if (
      db
        .prepare(
          `SELECT 1 FROM quick_replies WHERE scope=? AND ${owner[0]}=? AND shortcut=? AND archived_at IS NULL AND id!=?`,
        )
        .get(r.scope, owner[1], data.shortcut, r.id)
    )
      throw fail(409, 'Ya existe una respuesta con el atajo «/' + data.shortcut + '».');
    db.prepare('UPDATE quick_replies SET shortcut=?,title=?,body=?,revision=revision+1,updated_at=? WHERE id=?').run(
      data.shortcut,
      data.title,
      data.body,
      now(),
      r.id,
    );
    return view(get(r.id), me);
  }
  function archive(user, id) {
    const { r } = editable(user, id);
    db.prepare('UPDATE quick_replies SET archived_at=?,updated_at=? WHERE id=?').run(now(), now(), r.id);
    return { archived: true };
  }
  // Arma el texto para una conversación concreta. No envía nada.
  function render(user, id, input) {
    const me = requireStaff(user),
      r = get(id);
    if (!r) throw fail(404, 'Respuesta rápida no encontrada.');
    if (r.scope === 'personal' && r.user_id !== me.id) throw fail(404, 'Respuesta rápida no encontrada.');
    if (typeof input?.conversationId !== 'string') throw fail(400, 'Indica la conversación.');
    const c = accessConversation(input.conversationId, user);
    crm.requireBrand(user, c.brand_id);
    if (r.scope === 'brand' && r.brand_id !== c.brand_id) throw fail(409, 'Esta respuesta es de otra marca.');
    const customer = db.prepare('SELECT name FROM users WHERE id=?').get(c.customer_id)?.name || '',
      course = db.prepare('SELECT title FROM courses WHERE id=?').get(c.course_id)?.title || '',
      edition = c.edition_id ? db.prepare('SELECT name FROM editions WHERE id=?').get(c.edition_id)?.name || '' : '';
    const out = fill(r.body, {
      nombre: customer.split(' ')[0] || '',
      nombre_completo: customer,
      curso: course,
      edicion: edition,
      marca: brandName(c.brand_id),
      asesor: me.name || '',
    });
    if (out.length > 5000) throw fail(400, 'El texto resultante es demasiado largo para un mensaje.');
    db.prepare('UPDATE quick_replies SET uses=uses+1,last_used_at=? WHERE id=?').run(now(), r.id);
    return { text: out, quickReplyId: r.id };
  }

  async function handle(req, res, path, user) {
    if (!(path === '/api/quick-replies' || path.startsWith('/api/quick-replies/'))) return false;
    let x;
    if (path === '/api/quick-replies') {
      if (req.method === 'GET') {
        json(res, 200, list(user));
        return true;
      }
      if (req.method === 'POST') {
        const out = create(user, await body(req));
        audit(user, 'quickreply.create', out.id);
        json(res, 201, { quickReply: out });
        return true;
      }
      throw fail(405, 'Método no permitido.');
    }
    if (!(x = path.match(/^\/api\/quick-replies\/([a-f0-9-]{36})(?:\/(render))?$/)))
      throw fail(404, 'Ruta de respuestas rápidas no encontrada.');
    if (x[2] === 'render' && req.method === 'POST') {
      json(res, 200, render(user, x[1], await body(req)));
      return true;
    }
    if (!x[2] && req.method === 'PATCH') {
      const out = update(user, x[1], await body(req));
      audit(user, 'quickreply.update', x[1]);
      json(res, 200, { quickReply: out });
      return true;
    }
    if (!x[2] && req.method === 'DELETE') {
      const out = archive(user, x[1]);
      audit(user, 'quickreply.archive', x[1]);
      json(res, 200, out);
      return true;
    }
    throw fail(405, 'Método no permitido.');
  }
  return { handle, list, create, update, archive, render };
}
