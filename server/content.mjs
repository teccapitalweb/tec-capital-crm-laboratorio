import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { transaction } from './database.mjs';
import { variables, templateValues, fillTemplate, validateTemplateBody } from './catalogue.mjs';
import { linkKeys } from './ai-provider.mjs';
import { encodeQR, qrSvgPath } from './qr.mjs';

// Contenido (Fase 2 · bloque 2.6). Cierra el ciclo de mensajes del curso con plantillas por evento: cada marca mapea un
// hecho (bienvenida por anuncio, pago pendiente, pago confirmado, recordatorio de sesión, grabación disponible, certificado
// listo) a una plantilla APROBADA de ese escenario; pagos, coordinación, certificados y el motor de respuestas piden el
// texto aquí y, si no hay plantilla mapeada, conservan su texto fijo (la grabación disponible sólo se avisa con plantilla).
// Funciones de contenido: «diseño» crea y edita borradores de flyers/plantillas (y sube archivos), «aprobación» aprueba o
// archiva; administración todo; el resto del equipo usa lo aprobado. Variantes redactadas por el adaptador de IA
// (simulado sin clave) que una persona acepta como borrador nuevo. Fichas SVG generadas desde el catálogo con caché por
// versión y guardables como flyer en borrador. Nada se envía sin plantilla aprobada; precios y fechas salen del catálogo.
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const esc = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export const EVENTS = {
  ad_welcome: {
    title: 'Bienvenida por anuncio',
    when: 'Primer mensaje de un cliente que llegó desde un anuncio; sustituye a la bienvenida del curso y se envía con el flyer del anuncio.',
    category: 'marketing',
    vars: ['nombre', 'marca', 'curso', 'edicion', 'fecha', 'precio', 'promocion'],
  },
  payment_pending: {
    title: 'Pago pendiente (enlace de pago)',
    when: 'Al crear el pedido y enviar el enlace de pago al cliente.',
    category: 'utility',
    vars: ['pedido', 'importe', 'enlace_pago', 'vigencia_pago', 'plan_pago'],
  },
  payment_confirmed: {
    title: 'Pago confirmado',
    when: 'Al confirmar el pago e inscribir al alumno.',
    category: 'utility',
    vars: ['pedido', 'importe', 'plan_pago'],
  },
  session_reminder: {
    title: 'Recordatorio de sesión',
    when: 'Cuando una sesión entra en la ventana de recordatorio de la marca (Coordinación).',
    category: 'utility',
    vars: ['sesion', 'fecha_sesion', 'enlace_sesion', 'grupo'],
  },
  recording_available: {
    title: 'Grabación disponible',
    when: 'Al registrar la grabación de una sesión en Coordinación; sin plantilla mapeada no se avisa.',
    category: 'utility',
    vars: ['sesion', 'grabacion'],
  },
  certificate_ready: {
    title: 'Certificado listo',
    when: 'Al emitir el certificado del alumno.',
    category: 'utility',
    vars: ['folio', 'enlace_certificado', 'asistencia'],
  },
  session_payment: {
    title: 'Pago de sesión (enlace de pago)',
    when: 'Al cobrar una sesión a un alumno con plan por sesión, desde Coordinación o con el recordatorio automático.',
    category: 'utility',
    vars: ['sesion', 'fecha_sesion', 'importe', 'enlace_pago', 'vigencia_pago'],
  },
  away_hours: {
    title: 'Fuera de horario',
    when: 'Cuando un cliente escribe fuera del horario de atención de la marca y su mensaje debe esperar a una persona. Se envía una sola vez cada 12 horas por conversación; sin plantilla mapeada no se envía nada.',
    category: 'service',
    vars: ['nombre', 'marca', 'apertura'],
  },
  survey_request: {
    title: 'Invitación a encuesta',
    when: 'Al enviar la encuesta de una sesión realizada o de la apertura a cada inscrito.',
    category: 'utility',
    vars: ['sesion', 'enlace_encuesta'],
  },
};
export const TONES = { formal: 'Formal', cercano: 'Cercano', breve: 'Breve' };
const PRICE_RE = /(\$\s?\d|\d[\d.,]*\s?(pesos|mxn|usd)\b)/i;
// Una variante es válida si usa sólo variables permitidas, conserva las variables del original (enlaces y datos no se
// pierden), no añade enlaces ni importes escritos a mano y cabe en el límite de una plantilla.
export function validateVariant(body, original) {
  const b = String(body || '').trim();
  if (b.length < 10 || b.length > 3000) return 'La variante debe tener entre 10 y 3000 caracteres.';
  const used = [...b.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map(m => m[1]),
    orig = [...String(original).matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map(m => m[1]);
  if (used.some(v => !variables.includes(v))) return 'La variante usa una variable que no existe.';
  const missing = orig.filter(v => !used.includes(v));
  if (missing.length)
    return 'La variante omite variables del original: ' + missing.map(v => '{{' + v + '}}').join(', ') + '.';
  const allowed = new Set(
    linkKeys(original)
      .filter(l => !l.invalid)
      .map(l => l.key),
  );
  for (const l of linkKeys(b)) {
    if (l.invalid || !allowed.has(l.key)) return 'La variante añade un enlace que no estaba en el original.';
  }
  if (PRICE_RE.test(b) && !PRICE_RE.test(original))
    return 'La variante escribe un importe a mano; los precios sólo salen de {{precio}}.';
  return null;
}

export function createContent({
  db,
  crm,
  catalogue,
  events,
  insertMessage,
  provider,
  body,
  json,
  audit,
  broadcast,
  dataDir,
  now = Date.now,
  env = process.env,
}) {
  const roleOf = user => db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
  function access(user) {
    const u = roleOf(user);
    if (!u || u.disabled || u.role === 'customer') return { design: false, approve: false, admin: false };
    if (u.role === 'admin') return { design: true, approve: true, admin: true };
    const a = db.prepare('SELECT can_design,can_approve FROM content_access WHERE user_id=?').get(user.id) || {};
    return { design: Boolean(a.can_design || a.can_approve), approve: Boolean(a.can_approve), admin: false };
  }
  const requireStaff = user => {
    const u = roleOf(user);
    if (!u || u.disabled || u.role === 'customer') throw fail(403, 'El contenido es para el equipo de atención.');
    return u;
  };
  const requireAdmin = user => {
    if (!access(user).admin) throw fail(403, 'Esta acción requiere un administrador.');
  };
  const requireDesign = user => {
    if (!access(user).design)
      throw fail(403, 'Crear o editar contenido requiere la función de diseño (la concede administración).');
  };
  const requireApprove = user => {
    if (!access(user).approve)
      throw fail(
        403,
        'Aprobar, archivar o mapear plantillas requiere la función de aprobación (la concede administración).',
      );
  };
  // Puerta que usa el catálogo para flyers, plantillas y archivos: antes todo era de administración.
  function gate(user, type, action) {
    if (['approve', 'archive'].includes(action || '')) requireApprove(user);
    else requireDesign(user);
  }
  const brandName = id => db.prepare('SELECT name FROM brands WHERE id=?').get(id)?.name || id;
  const origin = () => (env.APP_ORIGIN || '').replace(/\/$/, '');

  // ---- plantillas por evento
  const mapping = (brandId, event) =>
    db.prepare('SELECT * FROM event_templates WHERE brand_id=? AND event=?').get(brandId, event) || {
      brand_id: brandId,
      event,
      template_id: null,
      enabled: 1,
      revision: 0,
      updated_by: null,
      updated_at: null,
    };
  const approvedFor = (brandId, event) =>
    db
      .prepare(
        "SELECT id,title,body,revision,channel FROM content_templates WHERE brand_id=? AND scenario=? AND status='approved' ORDER BY title",
      )
      .all(brandId, event);
  // Texto del evento para una conversación/pedido: null si la marca no tiene plantilla aprobada mapeada y activa.
  function render(event, brandId, { courseId, editionId = null, name = null, extra = {} }) {
    if (!EVENTS[event]) throw fail(400, 'Evento de plantilla no válido.');
    const m = mapping(brandId, event);
    if (!m.template_id || !m.enabled) return null;
    const t = db
      .prepare("SELECT * FROM content_templates WHERE id=? AND brand_id=? AND status='approved' AND scenario=?")
      .get(m.template_id, brandId, event);
    if (!t) return null;
    let values = {};
    try {
      values = templateValues(catalogue.info(courseId, editionId), name);
    } catch {
      values = { nombre: name || 'Hola', marca: brandName(brandId) };
    }
    const out = fillTemplate(t.body, { ...values, ...extra });
    if (out.length > 5000) return null;
    return { text: out, templateId: t.id, templateRevision: t.revision, category: EVENTS[event].category };
  }
  function eventsView(user, brand) {
    requireStaff(user);
    const ids = crm
      .brandsFor(user)
      .map(b => b.id)
      .filter(id => !brand || brand === 'all' || id === brand);
    return {
      events: Object.entries(EVENTS).map(([id, e]) => ({ id, ...e })),
      brands: ids.map(id => ({
        id,
        name: brandName(id),
        mappings: Object.keys(EVENTS).map(ev => {
          const m = mapping(id, ev);
          const t = m.template_id
            ? db.prepare('SELECT id,title,status,revision FROM content_templates WHERE id=?').get(m.template_id)
            : null;
          return {
            event: ev,
            templateId: m.template_id,
            templateTitle: t?.title || null,
            templateStatus: t?.status || null,
            enabled: Boolean(m.enabled),
            revision: m.revision,
            candidates: approvedFor(id, ev).map(c => ({ id: c.id, title: c.title })),
          };
        }),
      })),
      access: access(user),
      variables,
      tones: TONES,
    };
  }
  function setMapping(brandId, event, input, user) {
    requireApprove(user);
    crm.requireBrand(user, brandId);
    if (!EVENTS[event]) throw fail(404, 'Evento no encontrado.');
    if (!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId)) throw fail(404, 'Marca no encontrada.');
    const cur = mapping(brandId, event);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== cur.revision)
      throw fail(409, 'El mapa de plantillas cambió. Recárgalo.');
    const templateId = text(input.templateId, 60) || null;
    if (templateId) {
      const t = db.prepare('SELECT * FROM content_templates WHERE id=?').get(templateId);
      if (!t || t.brand_id !== brandId) throw fail(404, 'Plantilla no encontrada en la marca.');
      if (t.scenario !== event) throw fail(400, 'La plantilla debe ser del escenario «' + EVENTS[event].title + '».');
      if (t.status !== 'approved') throw fail(409, 'Sólo se mapea una plantilla aprobada.');
    }
    const enabled = input.enabled === undefined ? cur.enabled : input.enabled ? 1 : 0,
      t = now();
    db.prepare(
      'INSERT INTO event_templates(brand_id,event,template_id,enabled,revision,updated_by,updated_at) VALUES(?,?,?,?,1,?,?) ON CONFLICT(brand_id,event) DO UPDATE SET template_id=excluded.template_id,enabled=excluded.enabled,revision=event_templates.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
    ).run(brandId, event, templateId, enabled, user.id, t);
    audit(user, 'content.event', brandId + ':' + event);
    broadcast('catalog');
    return mapping(brandId, event);
  }
  // Grabación disponible: sólo con plantilla mapeada; un mensaje por inscrito y grabación; respeta la baja.
  function onRecording(ev) {
    const p = ev.payload,
      e = db.prepare('SELECT * FROM editions WHERE id=?').get(p.editionId);
    if (!e) return 0;
    const s = p.sessionId ? db.prepare('SELECT * FROM edition_sessions WHERE id=?').get(p.sessionId) : null;
    let sent = 0;
    for (const r of db
      .prepare(
        "SELECT en.id enrollment_id,o.conversation_id,(SELECT status FROM contact_consent k WHERE k.contact_id=en.contact_id) consent FROM enrollments en JOIN orders o ON o.id=en.order_id WHERE en.edition_id=? AND en.status='enrolled'",
      )
      .all(e.id)) {
      if (r.consent === 'opted_out') continue;
      const ref = 'recording:' + ev.entity_id + ':' + r.enrollment_id;
      if (db.prepare('SELECT 1 FROM messages WHERE client_ref=?').get(ref)) continue;
      const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(r.conversation_id);
      if (!conv || conv.status === 'resolved') continue;
      const name = db.prepare('SELECT name FROM users WHERE id=?').get(conv.customer_id)?.name?.split(' ')[0] || null;
      const t = render('recording_available', e.brand_id, {
        courseId: e.course_id,
        editionId: e.id,
        name,
        extra: { sesion: s ? s.number + '. ' + s.title : 'Sesión', grabacion: p.url || '' },
      });
      if (!t) return 0;
      try {
        transaction(db, () =>
          insertMessage(conv, null, t.text, 'automation', ref, null, null, null, { category: 'utility' }),
        );
        sent++;
        broadcast('conversation', conv.id);
      } catch (err) {
        if (err?.status !== 409) throw err;
      }
    }
    return sent;
  }
  // ---- funciones de contenido
  const accessList = user => {
    requireAdmin(user);
    return db
      .prepare(
        "SELECT u.id,u.name,u.username,u.role,COALESCE(u.disabled,0) disabled,a.can_design,a.can_approve,a.created_at granted_at,g.name granted_by_name FROM users u LEFT JOIN content_access a ON a.user_id=u.id LEFT JOIN users g ON g.id=a.granted_by WHERE u.role IN ('agent','admin') ORDER BY u.role,u.name",
      )
      .all()
      .map(u => ({
        ...u,
        design: u.role === 'admin' || Boolean(u.can_design || u.can_approve),
        approve: u.role === 'admin' || Boolean(u.can_approve),
      }));
  };
  function setAccess(input, user) {
    requireAdmin(user);
    const id = text(input.userId, 60),
      u = db.prepare('SELECT role FROM users WHERE id=?').get(id);
    if (!u || u.role === 'customer') throw fail(404, 'Persona del equipo no encontrada.');
    if (u.role === 'admin') throw fail(409, 'Administración ya tiene todas las funciones.');
    if (input.design || input.approve)
      db.prepare(
        'INSERT INTO content_access(user_id,can_design,can_approve,granted_by,created_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET can_design=excluded.can_design,can_approve=excluded.can_approve,granted_by=excluded.granted_by,created_at=excluded.created_at',
      ).run(id, input.design ? 1 : 0, input.approve ? 1 : 0, user.id, now());
    else db.prepare('DELETE FROM content_access WHERE user_id=?').run(id);
    audit(user, 'content.access', id);
    return accessList(user);
  }
  // ---- variantes asistidas por IA (fuera de transacción; la persona acepta o rechaza)
  async function makeVariants(t, input, user) {
    requireDesign(user);
    crm.requireBrand(user, t.brand_id);
    const tones = Array.isArray(input.tones) ? input.tones.filter(x => TONES[x]) : Object.keys(TONES);
    if (!tones.length) throw fail(400, 'Elige al menos un tono.');
    if (db.prepare("SELECT count(*) n FROM template_variants WHERE template_id=? AND status='draft'").get(t.id).n >= 12)
      throw fail(409, 'Hay demasiadas variantes sin decidir para esta plantilla. Acepta o rechaza algunas.');
    const p = typeof provider === 'function' ? provider() : provider;
    const r = await p.rewrite({
      brand: { name: brandName(t.brand_id) },
      template: { title: t.title, scenario: t.scenario, body: t.body },
      tones,
      variables,
    });
    const out = [],
      rejected = [];
    for (const v of r.variants || []) {
      const problem = validateVariant(v.body, t.body);
      if (problem) {
        rejected.push({ tone: v.tone, problem });
        continue;
      }
      const id = randomUUID();
      db.prepare(
        "INSERT INTO template_variants(id,template_id,brand_id,tone,body,provider,model,reason,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,'draft',?,?)",
      ).run(
        id,
        t.id,
        t.brand_id,
        v.tone,
        v.body.trim(),
        p.name,
        r.model || p.model,
        String(r.reason || '').slice(0, 200),
        user.id,
        now(),
      );
      out.push(variant(id));
    }
    audit(user, 'content.variants', t.id + ':' + out.length);
    return { variants: out, rejected, provider: p.name, model: r.model || p.model, reason: r.reason || '' };
  }
  const variant = id => {
    const v = db
      .prepare(
        'SELECT v.*,u.name created_by_name FROM template_variants v LEFT JOIN users u ON u.id=v.created_by WHERE v.id=?',
      )
      .get(id);
    return v && { ...v, toneLabel: TONES[v.tone] || v.tone };
  };
  const variantsOf = (t, user) => {
    requireStaff(user);
    crm.requireBrand(user, t.brand_id);
    return db
      .prepare('SELECT id FROM template_variants WHERE template_id=? ORDER BY created_at DESC LIMIT 30')
      .all(t.id)
      .map(r => variant(r.id));
  };
  function decideVariant(id, accept, user) {
    const v = db.prepare('SELECT * FROM template_variants WHERE id=?').get(id);
    if (!v) throw fail(404, 'Variante no encontrada.');
    requireDesign(user);
    crm.requireBrand(user, v.brand_id);
    if (v.status !== 'draft') throw fail(409, 'La variante ya fue decidida.');
    const t = now();
    return transaction(db, () => {
      let created = null;
      if (accept) {
        const src = db.prepare('SELECT * FROM content_templates WHERE id=?').get(v.template_id);
        if (!src) throw fail(404, 'La plantilla original ya no existe.');
        const problem = validateVariant(v.body, src.body);
        if (problem) throw fail(409, problem);
        validateTemplateBody(v.body);
        created = randomUUID();
        const row = {
          id: created,
          brand_id: src.brand_id,
          course_id: src.course_id,
          edition_id: src.edition_id,
          flyer_id: src.flyer_id,
          title: (src.title + ' · variante ' + (TONES[v.tone] || v.tone).toLowerCase()).slice(0, 180),
          scenario: src.scenario,
          channel: src.channel,
          body: v.body,
          status: 'draft',
          revision: 1,
          approved_by: null,
          approved_at: null,
          created_at: t,
          updated_at: t,
        };
        db.prepare(
          'INSERT INTO content_templates(id,brand_id,course_id,edition_id,flyer_id,title,scenario,channel,body,status,revision,approved_by,approved_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(...Object.values(row));
        db.prepare(
          'INSERT INTO catalogue_events(brand_id,entity_kind,entity_id,revision,action,actor_id,snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          row.brand_id,
          'template',
          created,
          1,
          'created',
          user.id,
          JSON.stringify({ ...row, source: 'variante IA ' + v.tone + ' de ' + v.template_id }),
          t,
        );
      }
      db.prepare(
        "UPDATE template_variants SET status=?,decided_by=?,decided_at=?,accepted_template_id=? WHERE id=? AND status='draft'",
      ).run(accept ? 'accepted' : 'rejected', user.id, t, created, id);
      audit(user, accept ? 'content.variant.accept' : 'content.variant.reject', id);
      if (created) broadcast('catalog');
      return { variant: variant(id), templateId: created };
    });
  }
  // ---- fichas SVG desde el catálogo (caché por versión del curso, edición y promoción)
  function sheetKey(ctx) {
    return [
      ctx.course.version,
      ctx.edition.revision,
      ctx.promotion?.id || '',
      ctx.promotion?.revision || '',
      ctx.brand.name,
    ].join(':');
  }
  function sheetSvg(ctx) {
    const { course: c, edition: e, promotion: p, brand } = ctx,
      W = 1080,
      H = 1080,
      money = v => new Intl.NumberFormat('es-MX', { style: 'currency', currency: e.currency }).format(v / 100);
    const ad = db
        .prepare("SELECT id FROM flyers WHERE edition_id=? AND status='approved' ORDER BY updated_at DESC LIMIT 1")
        .get(e.id),
      link = origin() + (ad ? '/?ad=' + ad.id : '/'),
      qr = encodeQR(link || '/'),
      { path, side } = qrSvgPath(qr, 4, 2);
    const wrap = (s, n) => {
      const words = String(s).split(/\s+/),
        lines = [];
      let cur = '';
      for (const w of words) {
        if ((cur + ' ' + w).trim().length > n) {
          lines.push(cur.trim());
          cur = w;
        } else cur += ' ' + w;
      }
      if (cur.trim()) lines.push(cur.trim());
      return lines.slice(0, 3);
    };
    const title = wrap(c.title, 22),
      modality = { online: 'En línea', in_person: 'Presencial', hybrid: 'Híbrida' }[e.modality] || e.modality;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter, 'Segoe UI', Helvetica, Arial, sans-serif">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eef1f6"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/><rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="28" fill="#ffffff" stroke="#e3e6ec"/>
<text x="96" y="140" font-size="26" fill="#67717d" letter-spacing="4">${esc(brand.name.toUpperCase())}</text>
<text x="96" y="186" font-size="20" fill="#8a919c">CURSO EN VIVO · ${esc(modality.toUpperCase())}</text>
${title.map((l, i) => `<text x="96" y="${300 + i * 78}" font-size="66" font-weight="600" fill="#1f242c">${esc(l)}</text>`).join('')}
<text x="96" y="${300 + title.length * 78 + 30}" font-size="30" fill="#4b5565">${esc(e.name)}</text>
<text x="96" y="${300 + title.length * 78 + 86}" font-size="30" fill="#1f242c">${esc(ctx.dateLabel)}</text>
${e.instructor ? `<text x="96" y="${300 + title.length * 78 + 134}" font-size="26" fill="#67717d">Imparte ${esc(e.instructor)}</text>` : ''}
<rect x="96" y="${H - 330}" width="${W - 192}" height="150" rx="22" fill="#f6f7fa" stroke="#e6e8ee"/>
<text x="128" y="${H - 268}" font-size="24" fill="#67717d">${p ? 'Promoción «' + esc(p.name) + '»' : 'Inversión'}</text>
<text x="128" y="${H - 212}" font-size="54" font-weight="600" fill="#1f242c">${esc(money(ctx.priceCents))}</text>
${p ? `<text x="${128 + money(ctx.priceCents).length * 34}" y="${H - 212}" font-size="26" fill="#8a919c" text-decoration="line-through">${esc(money(e.price_cents))}</text>` : ''}
<g transform="translate(${W - 96 - side},${H - 330 + (150 - side) / 2})"><rect width="${side}" height="${side}" fill="#fff" rx="8"/><path d="${path}" fill="#1f242c" shape-rendering="crispEdges"/></g>
<text x="96" y="${H - 120}" font-size="26" fill="#1f242c" font-weight="500">Escríbenos por WhatsApp, Instagram o Facebook</text>
<text x="96" y="${H - 84}" font-size="20" fill="#8a919c">${esc(link)} · Laboratorio: ficha de práctica con datos del catálogo</text>
</svg>`;
  }
  function sheet(editionId, user, { refresh = false } = {}) {
    requireStaff(user);
    const e = db.prepare('SELECT * FROM editions WHERE id=?').get(editionId);
    if (!e) throw fail(404, 'Edición no disponible.');
    crm.requireBrand(user, e.brand_id);
    const ctx = catalogue.info(e.course_id, e.id),
      key = sheetKey(ctx),
      cached = db.prepare('SELECT * FROM content_sheets WHERE edition_id=?').get(e.id);
    if (cached && cached.version_key === key && !refresh) return { svg: cached.svg, cached: true, key };
    const svg = sheetSvg(ctx);
    db.prepare(
      'INSERT INTO content_sheets(edition_id,version_key,svg,created_at) VALUES(?,?,?,?) ON CONFLICT(edition_id) DO UPDATE SET version_key=excluded.version_key,svg=excluded.svg,created_at=excluded.created_at',
    ).run(e.id, key, svg, now());
    return { svg, cached: false, key };
  }
  async function sheetToFlyer(editionId, input, user) {
    requireDesign(user);
    const e = db.prepare('SELECT * FROM editions WHERE id=?').get(editionId);
    if (!e) throw fail(404, 'Edición no disponible.');
    crm.requireBrand(user, e.brand_id);
    const { svg } = sheet(editionId, user),
      ctx = catalogue.info(e.course_id, e.id),
      t = now(),
      storageName = 'sheet-' + randomUUID() + '.svg',
      fileId = randomUUID(),
      flyerId = randomUUID();
    await mkdir(resolve(dataDir, 'library'), { recursive: true });
    await writeFile(resolve(dataDir, 'library', storageName), svg, { flag: 'wx' });
    const title = text(input.title, 180) || ('Ficha generada · ' + ctx.course.title + ' · ' + e.name).slice(0, 180);
    transaction(db, () => {
      db.prepare(
        'INSERT INTO library_files(id,brand_id,filename,mime,size,storage_name,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        fileId,
        e.brand_id,
        'ficha-' + e.id + '.svg',
        'image/svg+xml',
        Buffer.byteLength(svg),
        storageName,
        user.id,
        t,
      );
      const row = {
        id: flyerId,
        brand_id: e.brand_id,
        course_id: e.course_id,
        edition_id: e.id,
        promotion_id: null,
        file_id: fileId,
        title,
        channel: 'all',
        expires_at: null,
        status: 'draft',
        binding: JSON.stringify({ course: ctx.course.version, edition: e.revision, promotion: null }),
        revision: 1,
        approved_by: null,
        approved_at: null,
        created_at: t,
        updated_at: t,
      };
      db.prepare(
        'INSERT INTO flyers(id,brand_id,course_id,edition_id,promotion_id,file_id,title,channel,expires_at,status,binding,revision,approved_by,approved_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(...Object.values(row));
      db.prepare(
        'INSERT INTO catalogue_events(brand_id,entity_kind,entity_id,revision,action,actor_id,snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(
        e.brand_id,
        'flyer',
        flyerId,
        1,
        'created',
        user.id,
        JSON.stringify({ ...row, source: 'ficha generada' }),
        t,
      );
    });
    audit(user, 'content.sheet.flyer', flyerId);
    broadcast('catalog');
    return { flyerId, fileId };
  }

  events.subscribe('grabacion.disponible', 'content.recording', onRecording);

  async function handle(req, res, path, user) {
    if (!path.startsWith('/api/content')) return false;
    const p = new URL(req.url, 'http://localhost').searchParams;
    let x;
    if (path === '/api/content/me' && req.method === 'GET') {
      json(res, 200, access(user));
      return true;
    }
    if (path === '/api/content/events' && req.method === 'GET') {
      json(res, 200, eventsView(user, p.get('brand')));
      return true;
    }
    if ((x = path.match(/^\/api\/content\/events\/([a-zA-Z0-9-]+)\/([a-z_]+)$/)) && req.method === 'PUT') {
      json(res, 200, { mapping: setMapping(x[1], x[2], await body(req), user) });
      return true;
    }
    if (path === '/api/content/access') {
      if (req.method === 'GET') {
        json(res, 200, { members: accessList(user) });
        return true;
      }
      if (req.method === 'PUT') {
        json(res, 200, { members: setAccess(await body(req), user) });
        return true;
      }
    }
    if ((x = path.match(/^\/api\/content\/templates\/([a-z0-9-]+)\/variants$/))) {
      const t = db.prepare('SELECT * FROM content_templates WHERE id=?').get(x[1]);
      if (!t) throw fail(404, 'Plantilla no encontrada.');
      if (req.method === 'GET') {
        json(res, 200, { variants: variantsOf(t, user), tones: TONES });
        return true;
      }
      if (req.method === 'POST') {
        json(res, 201, await makeVariants(t, await body(req), user));
        return true;
      }
      throw fail(405, 'Método no permitido.');
    }
    if ((x = path.match(/^\/api\/content\/variants\/([a-f0-9-]{36})\/(accept|reject)$/)) && req.method === 'POST') {
      json(res, 200, decideVariant(x[1], x[2] === 'accept', user));
      return true;
    }
    if ((x = path.match(/^\/api\/content\/sheets\/([a-zA-Z0-9-]+)(?:\.(svg)|\/(flyer))?$/))) {
      if (x[2] === 'svg' && req.method === 'GET') {
        const r = sheet(x[1], user, { refresh: p.get('refresh') === '1' });
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'X-Sheet-Cache': r.cached ? 'hit' : 'miss',
          'Content-Disposition': 'inline; filename="ficha-' + x[1] + '.svg"',
        });
        res.end(r.svg);
        return true;
      }
      if (x[3] === 'flyer' && req.method === 'POST') {
        json(res, 201, await sheetToFlyer(x[1], await body(req), user));
        return true;
      }
      throw fail(405, 'Método no permitido.');
    }
    throw fail(404, 'Ruta de contenido no encontrada.');
  }
  return { handle, access, gate, render, setMapping, sheet, validateVariant, onRecording };
}
