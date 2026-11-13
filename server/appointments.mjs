import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';

// Agenda de citas (docs/PLAN_AGENDA_CITAS.md). Una cita se agenda desde el chat: título, fecha y hora, duración, tipo (llamada, videollamada o
// presencial), lugar o enlace y notas. Opcionalmente deja un recordatorio para el cliente, que es un mensaje programado normal (con sus reglas
// comprobadas al enviar). A quien la lleva se le avisa unos minutos antes. Reglas: la hora es futura; no se empalma con otra cita de la misma
// persona (salvo que lo confirme); cancelar o mover una cita cancela su recordatorio (el viejo ya no diría la hora correcta).
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
export const KINDS = ['llamada', 'videollamada', 'presencial'];
export const LIMITS = {
  minLeadMs: 60 * 1000,
  maxLeadMs: 180 * 86400 * 1000,
  minDuration: 5,
  maxDuration: 480,
  soonMs: 15 * 60 * 1000,
  maxOpenPerConversation: 10,
};

export function createAppointments({ db, crm, accessConversation, scheduled, broadcast, body, json, audit, rate }) {
  const now = () => Date.now();
  const view = (r, user) => ({
    id: r.id,
    conversationId: r.conversation_id,
    brandId: r.brand_id,
    ownerId: r.owner_id,
    ownerName: r.owner_name || null,
    mine: Boolean(user) && r.owner_id === user.id,
    title: r.title,
    startsAt: r.starts_at,
    endsAt: r.starts_at + r.duration_min * 60000,
    durationMin: r.duration_min,
    kind: r.kind,
    place: r.place || '',
    notes: r.notes || '',
    state: r.state,
    reminder: r.reminder_id
      ? (() => {
          const m = db.prepare('SELECT state,send_at,reason FROM scheduled_messages WHERE id=?').get(r.reminder_id);
          return m ? { id: r.reminder_id, state: m.state, sendAt: m.send_at, reason: m.reason || null } : null;
        })()
      : null,
    revision: r.revision,
    createdAt: r.created_at,
  });
  const row = id =>
    db
      .prepare('SELECT a.*,u.name owner_name FROM appointments a LEFT JOIN users u ON u.id=a.owner_id WHERE a.id=?')
      .get(id);
  const clash = (ownerId, start, end, exceptId) =>
    db
      .prepare(
        "SELECT id,title,starts_at FROM appointments WHERE owner_id=? AND state='scheduled' AND id<>? AND starts_at<? AND starts_at+duration_min*60000>?",
      )
      .get(ownerId, exceptId || '', end, start);

  function fields(input, current = {}) {
    const title = text(input.title ?? current.title, 120),
      startsAt = Number(input.startsAt ?? current.starts_at),
      duration = Number(input.durationMin ?? current.duration_min ?? 30),
      kind = input.kind ?? current.kind ?? 'llamada',
      place = text(input.place ?? current.place ?? '', 200),
      notes = text(input.notes ?? current.notes ?? '', 1000),
      t = now();
    if (!title) throw fail(400, 'Ponle un título a la cita.');
    if (!Number.isSafeInteger(startsAt)) throw fail(400, 'Elige la fecha y la hora.');
    const moved = current.starts_at === undefined || startsAt !== current.starts_at; // editar el título de una cita en curso no exige que la hora sea futura
    if (moved && startsAt < t + LIMITS.minLeadMs)
      throw fail(400, 'La cita tiene que ser en el futuro (al menos en un minuto).');
    if (moved && startsAt > t + LIMITS.maxLeadMs) throw fail(400, 'Sólo se puede agendar hasta 180 días adelante.');
    if (!Number.isInteger(duration) || duration < LIMITS.minDuration || duration > LIMITS.maxDuration)
      throw fail(400, 'La duración va de 5 minutos a 8 horas.');
    if (!KINDS.includes(kind)) throw fail(400, 'Tipo de cita no válido.');
    return { title, startsAt, duration, kind, place, notes };
  }
  // Recordatorio para el cliente: un mensaje programado normal. El texto lo redacta quien agenda (con la hora en su zona horaria); aquí sólo se programa.
  function remind(c, user, startsAt, input) {
    const r = input?.reminder;
    if (!r || !text(r.text, 5000)) return { id: null, warning: null };
    const sendAt = startsAt - Math.max(5, Math.min(Number(r.minutesBefore) || 60, 7 * 24 * 60)) * 60000;
    if (sendAt < now() + 30 * 1000)
      return { id: null, warning: 'La cita es muy pronto: no se programó el recordatorio al cliente.' };
    try {
      return {
        id: scheduled.create(c, user, { text: r.text, sendAt, cancelOnReply: false, clientRef: randomUUID() }).item.id,
        warning: null,
      };
    } catch (e) {
      if (e.status)
        return { id: null, warning: 'La cita se agendó, pero el recordatorio no se pudo programar: ' + e.message };
      throw e;
    }
  }
  function create(c, user, input) {
    const clientRef = text(input.clientRef, 100);
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(clientRef)) throw fail(400, 'Referencia no válida.');
    const again = db
      .prepare('SELECT id,conversation_id FROM appointments WHERE owner_id=? AND client_ref=?')
      .get(user.id, clientRef);
    if (again) {
      if (again.conversation_id !== c.id) throw fail(409, 'Referencia ya utilizada.');
      return { item: view(row(again.id), user), duplicate: true, warning: null };
    }
    if (c.status === 'resolved') throw fail(409, 'La conversación está cerrada.');
    if (c.assigned_to && c.assigned_to !== user.id && user.role !== 'admin')
      throw fail(409, 'Otro asesor está atendiendo esta conversación.');
    const f = fields(input),
      end = f.startsAt + f.duration * 60000,
      id = randomUUID(),
      t = now();
    let warning = null;
    // Primero todas las comprobaciones, luego el recordatorio (que abre su propia transacción) y al final la fila. Si la fila fallara, el recordatorio se retira.
    if (
      db.prepare("SELECT count(*) n FROM appointments WHERE conversation_id=? AND state='scheduled'").get(c.id).n >=
      LIMITS.maxOpenPerConversation
    )
      throw fail(409, 'Este chat ya tiene ' + LIMITS.maxOpenPerConversation + ' citas pendientes.');
    const other = input.allowOverlap === true ? null : clash(user.id, f.startsAt, end);
    if (other)
      throw fail(409, 'Ya tienes «' + other.title + '» a esa hora. Elige otra o confirma que quieres empalmarlas.');
    const rem = remind(c, user, f.startsAt, input);
    warning = rem.warning;
    try {
      db.prepare(
        'INSERT INTO appointments(id,conversation_id,brand_id,owner_id,title,starts_at,duration_min,kind,place,notes,reminder_id,client_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        c.id,
        c.brand_id,
        user.id,
        f.title,
        f.startsAt,
        f.duration,
        f.kind,
        f.place || null,
        f.notes || null,
        rem.id,
        clientRef,
        t,
        t,
      );
    } catch (e) {
      if (rem.id) scheduled.cancelSystem(rem.id, 'No se pudo agendar la cita.');
      throw e;
    }
    return { item: view(row(id), user), duplicate: false, warning };
  }
  function mine(user, id) {
    const r = row(id);
    if (!r) throw fail(404, 'Cita no disponible.');
    const c = accessConversation(r.conversation_id, user); // alcance por marca: otra marca recibe 404
    if (r.owner_id !== user.id && user.role !== 'admin')
      throw fail(403, 'Sólo quien agendó la cita o administración puede cambiarla.');
    return { r, c };
  }
  function dropReminder(r, why) {
    if (r.reminder_id) scheduled.cancelSystem(r.reminder_id, why);
  }
  function edit(user, id, input) {
    const { r, c } = mine(user, id);
    if (r.state !== 'scheduled') throw fail(409, 'Esta cita ya no está pendiente.');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== r.revision)
      throw fail(409, 'Otra persona la cambió. Vuelve a abrirla.');
    const f = fields(input, r),
      moved = f.startsAt !== r.starts_at;
    let warning = null;
    const other =
      input.allowOverlap === true || (!moved && f.duration === r.duration_min)
        ? null
        : clash(r.owner_id, f.startsAt, f.startsAt + f.duration * 60000, r.id); // cambiar el título no vuelve a juzgar un empalme ya aceptado
    if (other)
      throw fail(409, 'Ya tienes «' + other.title + '» a esa hora. Elige otra o confirma que quieres empalmarlas.');
    let reminderId = r.reminder_id;
    if (moved || input.reminder) {
      dropReminder(r, 'La cita cambió de hora o de recordatorio.');
      const rem = remind(c, user, f.startsAt, input);
      reminderId = rem.id;
      warning =
        rem.warning ||
        (moved && !input.reminder && r.reminder_id
          ? 'Se movió la cita: el recordatorio anterior se canceló. Programa uno nuevo si lo necesitas.'
          : null);
    }
    db.prepare(
      "UPDATE appointments SET title=?,starts_at=?,duration_min=?,kind=?,place=?,notes=?,reminder_id=?,revision=revision+1,updated_at=? WHERE id=? AND state='scheduled' AND revision=?",
    ).run(f.title, f.startsAt, f.duration, f.kind, f.place || null, f.notes || null, reminderId, now(), id, r.revision);
    return { item: view(row(id), user), warning };
  }
  function setState(user, id, state) {
    const { r } = mine(user, id);
    if (r.state !== 'scheduled') throw fail(409, 'Esta cita ya no está pendiente.');
    if (!['done', 'no_show', 'cancelled'].includes(state)) throw fail(400, 'Estado no válido.');
    if (state !== 'cancelled' && r.starts_at > now())
      throw fail(409, 'La cita todavía no empieza. Si ya no va a ocurrir, cancélala.');
    transaction(db, () => {
      db.prepare(
        "UPDATE appointments SET state=?,revision=revision+1,updated_at=? WHERE id=? AND state='scheduled'",
      ).run(state, now(), id);
      if (state === 'cancelled') dropReminder(r, 'La cita se canceló.');
    });
    return view(row(id), user);
  }
  function list(c, user) {
    const since = now() - 3 * 86400 * 1000;
    return db
      .prepare(
        "SELECT a.*,u.name owner_name FROM appointments a LEFT JOIN users u ON u.id=a.owner_id WHERE a.conversation_id=? AND (a.state='scheduled' OR a.updated_at>=?) ORDER BY a.starts_at LIMIT 40",
      )
      .all(c.id, since)
      .map(r => view(r, user));
  }
  // Mi día: mis citas pendientes de hoy en adelante (y las ya vencidas sin marcar, para que no se queden sin cerrar).
  function mineList(user) {
    return db
      .prepare(
        "SELECT a.*,u.name owner_name,cu.name customer_name,b.name brand_name FROM appointments a JOIN conversations c ON c.id=a.conversation_id JOIN users cu ON cu.id=c.customer_id JOIN brands b ON b.id=a.brand_id LEFT JOIN users u ON u.id=a.owner_id WHERE a.owner_id=? AND a.state='scheduled' AND a.starts_at+a.duration_min*60000>=? ORDER BY a.starts_at LIMIT 30",
      )
      .all(user.id, now() - 6 * 3600 * 1000)
      .filter(r => crm.canBrand(user, r.brand_id))
      .map(r => ({ ...view(r, user), customerName: r.customer_name, brandName: r.brand_name }));
  }
  // Agenda por rango (vista semanal): las citas de [from,to) sin canceladas; «mine» sólo las propias, «team» las de todas las marcas que la persona ve
  // (opcionalmente una marca). Máximo 42 días y 500 citas.
  function range(user, { from, to, scope, brand }) {
    from = Number(from);
    to = Number(to);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from)
      throw fail(400, 'Rango de fechas no válido.');
    if (to - from > 42 * 86400 * 1000) throw fail(400, 'El rango máximo es de 42 días.');
    if (brand && !crm.canBrand(user, brand)) throw fail(404, 'Marca o registro no disponible.');
    const mineOnly = scope !== 'team',
      args = [from, to];
    let sql =
      "SELECT a.*,u.name owner_name,cu.name customer_name,b.name brand_name FROM appointments a JOIN conversations c ON c.id=a.conversation_id JOIN users cu ON cu.id=c.customer_id JOIN brands b ON b.id=a.brand_id LEFT JOIN users u ON u.id=a.owner_id WHERE a.starts_at>=? AND a.starts_at<? AND a.state<>'cancelled'";
    if (mineOnly) {
      sql += ' AND a.owner_id=?';
      args.push(user.id);
    }
    if (brand) {
      sql += ' AND a.brand_id=?';
      args.push(brand);
    }
    sql += ' ORDER BY a.starts_at LIMIT 500';
    return db
      .prepare(sql)
      .all(...args)
      .filter(r => crm.canBrand(user, r.brand_id))
      .map(r => ({ ...view(r, user), customerName: r.customer_name, brandName: r.brand_name }));
  }
  // Aviso a quien lleva la cita poco antes de que empiece (una sola vez por cita y hora: si se mueve, vuelve a avisar).
  function tick() {
    const t = now(),
      due = db
        .prepare("SELECT * FROM appointments WHERE state='scheduled' AND starts_at>? AND starts_at<=?")
        .all(t, t + LIMITS.soonMs);
    for (const r of due) {
      if (!crm.canBrand({ id: r.owner_id }, r.brand_id)) continue;
      const who =
        db
          .prepare('SELECT u.name FROM conversations c JOIN users u ON u.id=c.customer_id WHERE c.id=?')
          .get(r.conversation_id)?.name || 'el cliente';
      const mins = Math.max(1, Math.round((r.starts_at - t) / 60000));
      db.prepare(
        "INSERT OR IGNORE INTO notifications(id,user_id,brand_id,conversation_id,kind,title,event_key,created_at) VALUES(?,?,?,?,'appointment',?,?,?)",
      ).run(
        randomUUID(),
        r.owner_id,
        r.brand_id,
        r.conversation_id,
        (
          'Cita en unos minutos · ' +
          r.title +
          ' · ' +
          who +
          ' · ' +
          (r.kind === 'presencial' ? 'presencial' : r.kind) +
          (r.place ? ' · ' + r.place : '')
        ).slice(0, 300),
        'appointment:' + r.id + ':' + r.starts_at,
        t,
      );
    }
    return due.length;
  }

  async function handle(req, res, path, user) {
    if (path === '/api/appointments') {
      if (user.role === 'customer') throw fail(403, 'La agenda es para el equipo.');
      if (req.method !== 'GET') throw fail(405, 'Método no permitido.');
      const q = new URL(req.url, 'http://x').searchParams;
      if (q.has('from')) {
        json(res, 200, {
          items: range(user, {
            from: q.get('from'),
            to: q.get('to'),
            scope: q.get('scope'),
            brand: q.get('brand') || null,
          }),
        });
        return true;
      }
      json(res, 200, { items: mineList(user) });
      return true;
    }
    let m = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/appointments$/);
    if (m) {
      if (user.role === 'customer') throw fail(403, 'La agenda es para el equipo.');
      const c = accessConversation(m[1], user);
      crm.requireBrand(user, c.brand_id);
      if (req.method === 'GET') {
        json(res, 200, { items: list(c, user), kinds: KINDS });
        return true;
      }
      if (req.method === 'POST') {
        rate('appt:' + user.id, 60);
        const out = create(c, user, await body(req));
        if (!out.duplicate) {
          audit(user, 'appointment.create', out.item.id);
          broadcast('conversation', c.id);
        }
        json(res, out.duplicate ? 200 : 201, { item: out.item, duplicate: out.duplicate, warning: out.warning });
        return true;
      }
      throw fail(405, 'Método no permitido.');
    }
    m = path.match(/^\/api\/appointments\/([a-f0-9-]+)(?:\/(state))?$/);
    if (!m) return false;
    if (user.role === 'customer') throw fail(403, 'La agenda es para el equipo.');
    rate('appt:' + user.id, 120);
    if (!m[2] && req.method === 'PATCH') {
      const out = edit(user, m[1], await body(req));
      audit(user, 'appointment.edit', m[1]);
      broadcast('conversation', out.item.conversationId);
      json(res, 200, out);
      return true;
    }
    if (m[2] === 'state' && req.method === 'POST') {
      const input = await body(req);
      const item = setState(user, m[1], input.state);
      audit(user, 'appointment.' + item.state, m[1]);
      broadcast('conversation', item.conversationId);
      json(res, 200, { item });
      return true;
    }
    throw fail(405, 'Método no permitido.');
  }
  return { handle, tick, list, mineList, range };
}
