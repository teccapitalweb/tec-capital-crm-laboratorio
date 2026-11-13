import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';

// Aliados (docs/PLAN_ALIADOS.md): el panel RH de IPCIL dentro del CRM. Recibe las postulaciones de academias al programa «Aliado
// Certificador», lleva su recorrido (nueva → contactada → aprobada o rechazada, e invitación enviada) con el compromiso de contactarlas en
// menos de 24 horas, y las solicitudes de las marcas que piden ayuda para vincular su WhatsApp. Acceso: administración y las personas con la
// función de RH (la concede administración). La página pública de postulación está APAGADA por omisión (ALLY_FORM_ENABLED=1 la enciende):
// recoge datos personales de terceros y su aviso de privacidad definitivo necesita revisión legal. No se manda ningún correo ni mensaje
// desde aquí: la invitación es un texto que una persona copia y envía por su canal, y registra que lo hizo.
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .trim()
        .slice(0, max)
    : '';
const HOUR = 3600000,
  SLA_HOURS = 24;
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,200}\.[a-z]{2,24}$/i;
export const CERT = { '': 'No indica', si: 'Sí emite certificados', no: 'No emite certificados', a_veces: 'A veces' };
export const STATUS = { new: 'Por contactar', contacted: 'Contactada', approved: 'Aprobada', rejected: 'Rechazada' };
const esc = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw fail(413, 'La postulación es demasiado larga.');
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}
export const phone10 = v => {
  const d = String(v ?? '').replace(/\D/g, '');
  const t = d.length === 12 && d.startsWith('52') ? d.slice(2) : d;
  return /^\d{10}$/.test(t) ? t : null;
};

export function createAllies({ db, crm, body, json, audit, rate, now = Date.now, env = process.env }) {
  const roleOf = user => db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
  function access(user) {
    const u = roleOf(user);
    if (!u || u.disabled || u.role === 'customer') return { allowed: false, admin: false };
    if (u.role === 'admin') return { allowed: true, admin: true };
    return { allowed: Boolean(db.prepare('SELECT 1 FROM rh_access WHERE user_id=?').get(user.id)), admin: false };
  }
  const requireRh = user => {
    const a = access(user);
    if (!a.allowed) throw fail(403, 'Aliados es para administración y las personas con la función de RH.');
    return a;
  };
  const requireAdmin = user => {
    if (!access(user).admin) throw fail(403, 'Esta acción requiere un administrador.');
  };
  const requireStaff = user => {
    const u = roleOf(user);
    if (!u || u.disabled || u.role === 'customer') throw fail(403, 'Esta acción es para el equipo.');
  };
  const names = id => (id ? db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name || null : null);
  const formEnabled = () => env.ALLY_FORM_ENABLED === '1';

  // ---- validación común (staff y formulario público)
  function clean(input) {
    const academy = text(input.academy, 120),
      contact = text(input.contactName, 100),
      email = text(input.email, 120).toLowerCase(),
      whatsapp = phone10(input.whatsapp);
    if (academy.length < 2) throw fail(400, 'Escribe el nombre de la academia.');
    if (contact.length < 2) throw fail(400, 'Escribe el nombre de la persona de contacto.');
    if (!EMAIL.test(email)) throw fail(400, 'El correo no parece válido.');
    if (!whatsapp) throw fail(400, 'El WhatsApp debe tener 10 dígitos.');
    const cert = text(input.issuesCertificates, 10);
    if (!Object.hasOwn(CERT, cert)) throw fail(400, 'Indica si la academia emite certificados.');
    return {
      academy,
      contact,
      email,
      whatsapp,
      city: text(input.city, 60),
      state: text(input.state, 60),
      sector: text(input.sector, 60),
      years: text(input.years, 20),
      students: text(input.studentsMonth, 40),
      cert,
      web: text(input.web, 200),
      heard: text(input.heardFrom, 120),
      message: text(input.message, 1000),
    };
  }
  const rhUsers = () =>
    db
      .prepare(
        "SELECT u.id FROM users u WHERE COALESCE(u.disabled,0)=0 AND u.role IN ('admin','agent') AND (u.role='admin' OR u.id IN (SELECT user_id FROM rh_access))",
      )
      .all()
      .map(r => r.id);
  const anyBrand = () => db.prepare('SELECT id FROM brands ORDER BY created_at LIMIT 1').get()?.id;
  function notifyRh(title, key, brandId) {
    const t = now(),
      brand = brandId || anyBrand();
    if (!brand) return;
    for (const uid of rhUsers())
      db.prepare(
        'INSERT OR IGNORE INTO notifications(id,user_id,brand_id,conversation_id,kind,title,event_key,created_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(randomUUID(), uid, brand, null, 'allies', title, key, t);
  }

  // ---- postulaciones
  const view = r => ({
    id: r.id,
    academy: r.academy,
    contactName: r.contact_name,
    city: r.city,
    state: r.state,
    email: r.email,
    whatsapp: r.whatsapp,
    sector: r.sector,
    years: r.years,
    studentsMonth: r.students_month,
    issuesCertificates: r.issues_certificates,
    issuesLabel: CERT[r.issues_certificates],
    web: r.web,
    heardFrom: r.heard_from,
    message: r.message,
    status: r.status,
    statusLabel: STATUS[r.status],
    source: r.source,
    createdAt: r.created_at,
    overdue: r.status === 'new' && now() - r.created_at > SLA_HOURS * HOUR,
    hoursWaiting: r.status === 'new' ? Math.floor((now() - r.created_at) / HOUR) : null,
    contactedBy: names(r.contacted_by),
    contactedAt: r.contacted_at,
    contactNote: r.contact_note,
    decidedBy: names(r.decided_by),
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    invitedBy: names(r.invited_by),
    invitedAt: r.invited_at,
    inviteNote: r.invite_note,
  });
  const get = id => (typeof id === 'string' ? db.prepare('SELECT * FROM ally_applications WHERE id=?').get(id) : null);
  function list(user, { status, q }) {
    requireRh(user);
    const counts = Object.fromEntries(
      db
        .prepare('SELECT status,count(*) n FROM ally_applications GROUP BY status')
        .all()
        .map(r => [r.status, r.n]),
    );
    const where = [],
      args = [];
    if (Object.hasOwn(STATUS, status)) {
      where.push('status=?');
      args.push(status);
    }
    const term = text(q, 80).toLowerCase();
    if (term) {
      where.push('(lower(academy) LIKE ? OR lower(contact_name) LIKE ? OR lower(email) LIKE ? OR lower(city) LIKE ?)');
      const like = '%' + term.replace(/[%_]/g, ' ') + '%';
      args.push(like, like, like, like);
    }
    const rows = db
      .prepare(
        `SELECT * FROM ally_applications${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, CASE status WHEN 'new' THEN created_at END ASC, created_at DESC LIMIT 300`,
      )
      .all(...args)
      .map(view);
    return {
      rows,
      counts: {
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        new: counts.new || 0,
        contacted: counts.contacted || 0,
        approved: counts.approved || 0,
        rejected: counts.rejected || 0,
        overdue: db
          .prepare("SELECT count(*) n FROM ally_applications WHERE status='new' AND created_at<?")
          .get(now() - SLA_HOURS * HOUR).n,
      },
      slaHours: SLA_HOURS,
      formEnabled: formEnabled(),
      labels: { status: STATUS, cert: CERT },
    };
  }
  function create(user, input, source = 'manual') {
    const c = clean(input),
      ref = input.clientRef === undefined ? null : text(input.clientRef, 80);
    if (input.clientRef !== undefined && ref.length < 8) throw fail(400, 'Referencia de idempotencia no válida.');
    if (ref) {
      const same = db.prepare('SELECT * FROM ally_applications WHERE client_ref=?').get(ref);
      if (same) return view(same);
    }
    const dup = db
      .prepare('SELECT * FROM ally_applications WHERE email=? AND lower(academy)=lower(?) AND created_at>?')
      .get(c.email, c.academy, now() - 7 * 24 * HOUR);
    if (dup) return view(dup); // la misma academia y correo en la última semana no se repite
    const id = randomUUID(),
      t = now();
    transaction(db, () => {
      db.prepare(
        'INSERT INTO ally_applications(id,academy,contact_name,city,state,email,whatsapp,sector,years,students_month,issues_certificates,web,heard_from,message,source,client_ref,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        c.academy,
        c.contact,
        c.city,
        c.state,
        c.email,
        c.whatsapp,
        c.sector,
        c.years,
        c.students,
        c.cert,
        c.web,
        c.heard,
        c.message,
        source,
        ref,
        user?.id || null,
        t,
        t,
      );
      notifyRh(
        'Nueva postulación de aliado: ' +
          c.academy +
          (c.city ? ' · ' + c.city : '') +
          ' (contactar en menos de ' +
          SLA_HOURS +
          ' h)',
        'ally:' + id,
      );
      if (user) audit(user, 'allies.created', id);
    });
    return view(get(id));
  }
  function move(user, id, action, input) {
    requireRh(user);
    const r = get(id);
    if (!r) throw fail(404, 'Postulación no encontrada.');
    const note = text(input.note, 140),
      t = now();
    if (action === 'contacted') {
      if (r.status !== 'new') throw fail(409, 'Esa postulación ya no está por contactar.');
      db.prepare(
        "UPDATE ally_applications SET status='contacted',contacted_by=?,contacted_at=?,contact_note=?,updated_at=? WHERE id=?",
      ).run(user.id, t, note, t, id);
    } else if (action === 'approve') {
      if (!['new', 'contacted'].includes(r.status))
        throw fail(409, 'Sólo se aprueba una postulación nueva o contactada.');
      db.prepare(
        "UPDATE ally_applications SET status='approved',decided_by=?,decided_at=?,decision_note=?,updated_at=? WHERE id=?",
      ).run(user.id, t, note, t, id);
    } else if (action === 'reject') {
      if (!['new', 'contacted'].includes(r.status))
        throw fail(409, 'Sólo se rechaza una postulación nueva o contactada.');
      if (note.length < 5) throw fail(400, 'Anota el motivo del rechazo (mínimo 5 caracteres).');
      db.prepare(
        "UPDATE ally_applications SET status='rejected',decided_by=?,decided_at=?,decision_note=?,updated_at=? WHERE id=?",
      ).run(user.id, t, note, t, id);
    } else if (action === 'invited') {
      if (r.status !== 'approved') throw fail(409, 'La invitación se registra cuando la postulación está aprobada.');
      db.prepare('UPDATE ally_applications SET invited_by=?,invited_at=?,invite_note=?,updated_at=? WHERE id=?').run(
        user.id,
        t,
        note,
        t,
        id,
      );
    } else throw fail(404, 'Acción no encontrada.');
    audit(user, 'allies.' + action, id);
    return view(get(id));
  }
  // Texto de la invitación para copiar y enviar por correo o WhatsApp (no se envía desde aquí).
  const inviteText = r =>
    `Hola ${r.contact_name.split(' ')[0]}, gracias por postular a ${r.academy} al programa Aliado Certificador de IPCI. Revisamos tu postulación y fue aprobada. El siguiente paso es completar tu registro; en cuanto tengas el enlace de registro lo encuentras en este mensaje o te lo compartimos por aquí. Cualquier duda, respóndeme y con gusto te ayudo.`;

  // ---- solicitudes de vinculación de WhatsApp de una marca
  const crView = r => ({
    id: r.id,
    brandId: r.brand_id,
    brand: r.brand_name,
    name: r.name,
    role: r.role,
    email: r.email,
    phone: r.phone,
    schedule: r.schedule,
    note: r.note,
    status: r.status,
    requestedBy: names(r.requester_id),
    createdAt: r.created_at,
    contactedBy: names(r.contacted_by),
    contactedAt: r.contacted_at,
    contactNote: r.contact_note,
  });
  const CR_SQL = 'SELECT c.*,b.name brand_name FROM channel_requests c JOIN brands b ON b.id=c.brand_id';
  function createRequest(user, input) {
    requireStaff(user);
    const brandId = typeof input.brandId === 'string' ? input.brandId : '';
    if (!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId)) throw fail(404, 'Marca no disponible.');
    crm.requireBrand(user, brandId);
    const name = text(input.name, 100),
      phone = phone10(input.phone);
    if (name.length < 2) throw fail(400, 'Escribe tu nombre.');
    if (!phone) throw fail(400, 'El teléfono debe tener 10 dígitos.');
    const email = text(input.email, 120).toLowerCase();
    if (email && !EMAIL.test(email)) throw fail(400, 'El correo no parece válido.');
    const ref = input.clientRef === undefined ? null : text(input.clientRef, 80);
    if (input.clientRef !== undefined && ref.length < 8) throw fail(400, 'Referencia de idempotencia no válida.');
    if (ref) {
      const same = db.prepare(`${CR_SQL} WHERE c.client_ref=?`).get(ref);
      if (same) return crView(same);
    }
    if (db.prepare("SELECT 1 FROM channel_requests WHERE brand_id=? AND status='pending'").get(brandId))
      throw fail(409, 'Esa marca ya tiene una solicitud pendiente. Se atiende en orden.');
    const id = randomUUID(),
      t = now();
    transaction(db, () => {
      db.prepare(
        'INSERT INTO channel_requests(id,brand_id,requester_id,name,role,email,phone,schedule,note,client_ref,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        brandId,
        user.id,
        name,
        text(input.role, 60),
        email,
        phone,
        text(input.schedule, 100),
        text(input.note, 300),
        ref,
        t,
      );
      notifyRh(
        'Solicitud para vincular WhatsApp: ' +
          (db.prepare('SELECT name FROM brands WHERE id=?').get(brandId)?.name || 'marca') +
          ' · ' +
          name,
        'chreq:' + id,
        brandId,
      );
      audit(user, 'channel_request.created', id);
    });
    return crView(db.prepare(`${CR_SQL} WHERE c.id=?`).get(id));
  }
  function listRequests(user) {
    requireRh(user);
    const rows = db
      .prepare(`${CR_SQL} ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END,c.created_at DESC LIMIT 100`)
      .all()
      .map(crView);
    return { rows, pending: rows.filter(r => r.status === 'pending').length };
  }
  function markRequest(user, id, input) {
    requireRh(user);
    const r = db.prepare('SELECT * FROM channel_requests WHERE id=?').get(id);
    if (!r) throw fail(404, 'Solicitud no encontrada.');
    if (r.status !== 'pending') throw fail(409, 'Esa solicitud ya estaba contactada.');
    db.prepare(
      "UPDATE channel_requests SET status='contacted',contacted_by=?,contacted_at=?,contact_note=? WHERE id=?",
    ).run(user.id, now(), text(input.note, 140), id);
    audit(user, 'channel_request.contacted', id);
    return crView(db.prepare(`${CR_SQL} WHERE c.id=?`).get(id));
  }

  // ---- función de RH (administración)
  const accessList = user => {
    requireAdmin(user);
    return db
      .prepare(
        "SELECT u.id,u.name,u.username,u.role,COALESCE(u.disabled,0) disabled,a.created_at granted_at FROM users u LEFT JOIN rh_access a ON a.user_id=u.id WHERE u.role IN ('agent','admin') ORDER BY u.name",
      )
      .all()
      .map(r => ({ ...r, enabled: Boolean(r.granted_at) || r.role === 'admin', admin: r.role === 'admin' }));
  };
  function setAccess(input, user) {
    requireAdmin(user);
    const id = typeof input.userId === 'string' ? input.userId : '',
      u = db.prepare("SELECT id,role FROM users WHERE id=? AND role IN ('agent','admin')").get(id);
    if (!u) throw fail(404, 'Persona del equipo no encontrada.');
    if (u.role === 'admin') throw fail(400, 'Administración ya tiene acceso a Aliados.');
    if (input.enabled)
      db.prepare(
        'INSERT INTO rh_access(user_id,granted_by,created_at) VALUES(?,?,?) ON CONFLICT(user_id) DO NOTHING',
      ).run(id, user.id, now());
    else db.prepare('DELETE FROM rh_access WHERE user_id=?').run(id);
    audit(user, input.enabled ? 'allies.access.granted' : 'allies.access.revoked', id);
    return accessList(user);
  }

  async function handle(req, res, path, user) {
    const isReq = path.startsWith('/api/channel-requests');
    if (!path.startsWith('/api/allies') && !isReq) return false;
    const p = new URL(req.url, 'http://localhost').searchParams;
    let m;
    if (isReq) {
      if (path === '/api/channel-requests') {
        if (req.method === 'GET') {
          json(res, 200, listRequests(user));
          return true;
        }
        if (req.method === 'POST') {
          json(res, 201, { request: createRequest(user, await body(req)) });
          return true;
        }
      }
      if ((m = path.match(/^\/api\/channel-requests\/([a-f0-9-]{36})\/contacted$/)) && req.method === 'POST') {
        json(res, 200, { request: markRequest(user, m[1], await body(req)) });
        return true;
      }
      throw fail(404, 'Ruta de solicitudes no encontrada.');
    }
    if (path === '/api/allies/me' && req.method === 'GET') {
      json(res, 200, { ...access(user), formEnabled: formEnabled() });
      return true;
    }
    if (path === '/api/allies') {
      if (req.method === 'GET') {
        json(res, 200, list(user, { status: p.get('status'), q: p.get('q') }));
        return true;
      }
      if (req.method === 'POST') {
        requireRh(user);
        json(res, 201, { application: create(user, await body(req)) });
        return true;
      }
    }
    if (path === '/api/allies/access') {
      if (req.method === 'GET') {
        json(res, 200, { members: accessList(user) });
        return true;
      }
      if (req.method === 'PUT') {
        json(res, 200, { members: setAccess(await body(req), user) });
        return true;
      }
    }
    if (
      (m = path.match(/^\/api\/allies\/([a-f0-9-]{36})\/(contacted|approve|reject|invited)$/)) &&
      req.method === 'POST'
    ) {
      json(res, 200, { application: move(user, m[1], m[2], await body(req)) });
      return true;
    }
    if ((m = path.match(/^\/api\/allies\/([a-f0-9-]{36})\/invite-text$/)) && req.method === 'GET') {
      requireRh(user);
      const r = get(m[1]);
      if (!r) throw fail(404, 'Postulación no encontrada.');
      json(res, 200, { text: inviteText(r), email: r.email, whatsapp: r.whatsapp });
      return true;
    }
    throw fail(404, 'Ruta de Aliados no encontrada.');
  }

  // ---- página pública de postulación (sin script: formulario clásico; apagada por omisión)
  const SECTORS = [
    'Salud',
    'Veterinaria',
    'Estética y belleza',
    'Negocios y finanzas',
    'Tecnología',
    'Educación',
    'Otro',
  ];
  const STUDENTS = ['Menos de 20', '20 a 50', '51 a 100', 'Más de 100'];
  function page(state, values = {}) {
    const v = k => esc(values[k] || ''),
      sel = (k, opts) =>
        `<select name="${k}"><option value="">Elige…</option>${opts.map(o => `<option ${values[k] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    const head =
      '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Programa Aliado Certificador · Laboratorio TEC Capital</title><meta name="robots" content="noindex"><style>body{margin:0;background:#f1f4f6;color:#242428;font:15px/1.6 Inter,\'Segoe UI\',Helvetica,Arial,sans-serif}main{max-width:640px;margin:0 auto;padding:40px 16px}.card{background:#fff;border:1px solid #e1e6ea;border-radius:18px;padding:28px}.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#2f6f8f;font-weight:600}h1{font-size:24px;margin:6px 0 4px;font-weight:600}.sub{margin:0 0 18px;color:#636977;font-size:13px}label{display:block;font-size:13px;font-weight:500;margin:0 0 14px}input,select,textarea{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;border:1px solid #d7dbe3;border-radius:12px;font:inherit;font-size:14px;min-height:40px;background:#fff}.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.hp{position:absolute;left:-9999px;height:0;overflow:hidden}.check{display:flex;gap:8px;align-items:flex-start;font-weight:400}.check input{width:auto;margin-top:4px;min-height:0}button{display:inline-block;padding:11px 18px;border:1px solid #2f6f8f;border-radius:12px;background:#2f6f8f;color:#fff;font:inherit;font-size:13px;cursor:pointer;min-height:40px}.state{display:inline-block;padding:7px 14px;border-radius:20px;font-size:13px;border:1px solid #cfe6d9;background:#e7f4ed;color:#256b4e}.err{color:#a7433a;font-size:13px;background:#fcecea;border:1px solid #f2d2ce;border-radius:10px;padding:8px 12px}small{display:block;color:#636977;font-size:12px;margin-top:14px}@media(max-width:520px){.two{grid-template-columns:1fr}}</style></head><body><main><div class="card"><div class="eyebrow">Laboratorio TEC Capital</div>';
    const body = state?.ok
      ? '<h1>¡Gracias por postular!</h1><span class="state">Postulación recibida</span><p>Una persona del equipo te contactará por WhatsApp o correo en las próximas 24 horas hábiles.</p>'
      : `<h1>Programa Aliado Certificador</h1><p class="sub">Cuéntanos de tu academia. Te contactamos en menos de 24 horas.</p>${state?.error ? `<p class="err">${esc(state.error)}</p>` : ''}<form method="post" action="/aliados">
        <label>Nombre de la academia<input name="academy" required maxlength="120" value="${v('academy')}"></label>
        <div class="two"><label>Tu nombre<input name="contactName" required maxlength="100" value="${v('contactName')}"></label><label>WhatsApp (10 dígitos)<input name="whatsapp" required inputmode="numeric" maxlength="16" value="${v('whatsapp')}"></label></div>
        <label>Correo<input name="email" type="email" required maxlength="120" value="${v('email')}"></label>
        <div class="two"><label>Ciudad<input name="city" maxlength="60" value="${v('city')}"></label><label>Estado<input name="state" maxlength="60" value="${v('state')}"></label></div>
        <div class="two"><label>Sector${sel('sector', SECTORS)}</label><label>Alumnos al mes${sel('studentsMonth', STUDENTS)}</label></div>
        <div class="two"><label>Años operando<input name="years" maxlength="20" value="${v('years')}"></label><label>¿Emiten certificados?<select name="issuesCertificates"><option value="">Elige…</option><option value="si" ${values.issuesCertificates === 'si' ? 'selected' : ''}>Sí</option><option value="no" ${values.issuesCertificates === 'no' ? 'selected' : ''}>No</option><option value="a_veces" ${values.issuesCertificates === 'a_veces' ? 'selected' : ''}>A veces</option></select></label></div>
        <label>Sitio web o redes<input name="web" maxlength="200" value="${v('web')}"></label>
        <label>¿Cómo conociste el programa?<input name="heardFrom" maxlength="120" value="${v('heardFrom')}"></label>
        <label>Mensaje (opcional)<textarea name="message" rows="3" maxlength="1000">${v('message')}</textarea></label>
        <div class="hp" aria-hidden="true"><label>No llenes este campo<input name="website" tabindex="-1" autocomplete="off"></label></div>
        <label class="check"><input type="checkbox" name="consent" value="1" required> Acepto que usen estos datos sólo para contactarme sobre el programa.</label>
        <button type="submit">Enviar postulación</button></form>`;
    return (
      head +
      body +
      '<small>Versión de laboratorio: el aviso de privacidad definitivo está pendiente de revisión legal.</small></div></main></body></html>'
    );
  }
  async function handlePublic(req, res, path, ip) {
    if (path !== '/aliados') return false;
    const html = (status, s, v) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(s, v));
      return true;
    };
    if (!formEnabled()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>No disponible</title><p>Esta página no está disponible.</p>',
      );
      return true;
    }
    if (req.method === 'GET') {
      rate('ally-view:' + ip, 60);
      return html(200, null);
    }
    if (req.method !== 'POST') throw fail(405, 'Método no permitido.');
    rate('ally-post:' + ip, 5, 3600000); // pocas postulaciones por hora y por IP
    let form;
    try {
      form = await readForm(req);
    } catch (e) {
      if (!e.status || e.status >= 500) throw e;
      return html(e.status, { error: e.message });
    }
    if (form.website) return html(200, { ok: true }); // trampa para robots: se responde como si hubiera funcionado y no se guarda
    try {
      if (form.consent !== '1') throw fail(400, 'Debes aceptar el uso de tus datos para poder postular.');
      create(
        null,
        {
          academy: form.academy,
          contactName: form.contactName,
          email: form.email,
          whatsapp: form.whatsapp,
          city: form.city,
          state: form.state,
          sector: form.sector,
          years: form.years,
          studentsMonth: form.studentsMonth,
          issuesCertificates: form.issuesCertificates || '',
          web: form.web,
          heardFrom: form.heardFrom,
          message: form.message,
        },
        'public',
      );
      return html(200, { ok: true });
    } catch (e) {
      if (!e.status || e.status >= 500) throw e;
      return html(e.status, { error: e.message }, form);
    }
  }
  return { handle, handlePublic, access, list };
}
