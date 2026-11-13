import { randomUUID, randomBytes } from 'node:crypto';
import { transaction } from './database.mjs';
import { SURVEY_MODES } from './surveys.mjs';
import { publishSeatChange } from './catalogue-events.mjs';

// Coordinación académica (Fase 2 · bloque 2.3, arranque). La «apertura» del panel IPCIL y la «cohorte» de la Academia
// son la misma edición del catálogo: mínimo de alumnos, inscritos (desde enrollments, que nacen del pago confirmado),
// estado operativo (planeada → abierta → en curso → cerrada, o cancelada), responsable, grupo, sesiones con enlace de
// videollamada (simulado en el laboratorio; el adaptador de Google Calendar entra por useCalendar), materiales,
// grabaciones y asistencia. La venta confirmada entra sola: suscriptor de `pago.confirmado`. La parte automática
// (abrir al llegar al mínimo y recordar la sesión a los inscritos) está apagada por marca hasta que administración la active.
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const RUN_STATUS = {
  planned: 'Planeada',
  open: 'Abierta',
  running: 'En curso',
  closed: 'Cerrada',
  cancelled: 'Cancelada',
};
export const TRANSITIONS = {
  planned: ['open', 'cancelled'],
  open: ['running', 'cancelled', 'planned'],
  running: ['closed', 'cancelled'],
  closed: [],
  cancelled: [],
};
export const ATTENDANCE = { present: 'Presente', absent: 'Ausente', late: 'Retardo', excused: 'Justificado' };
const RESOURCE_KINDS = { material: 'Material', recording: 'Grabación', link: 'Enlace' };
const url = (v, max = 500) => {
  const s = text(v, max);
  if (!s) return '';
  try {
    if (!['https:', 'http:'].includes(new URL(s).protocol)) throw Error();
  } catch {
    throw fail(400, 'El enlace debe comenzar con https:// o http://.');
  }
  return s;
};
const when = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number.isFinite(Number(v)) ? Number(v) : Date.parse(String(v));
  return Number.isFinite(n) ? Math.round(n) : null;
};
const stamp = (t, tz) => {
  try {
    return new Intl.DateTimeFormat('es-MX', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: tz || 'America/Mexico_City',
    }).format(t);
  } catch {
    return new Date(t).toISOString();
  }
};

// Conector de calendario simulado: genera un enlace que nunca resuelve (dominio .test) y una referencia; la API real de
// Google Calendar/Meet cumplirá la misma interfaz {name, createEvent({title,startsAt,durationMin,description}) → {url,providerRef}}.
export const simulatedCalendar = {
  name: 'simulated',
  async createEvent() {
    const code = randomBytes(6).toString('hex');
    return {
      url:
        'https://meet.simulado.tec-capital.test/' + code.slice(0, 3) + '-' + code.slice(3, 7) + '-' + code.slice(7, 10),
      providerRef: 'simcal_' + code,
    };
  },
};

export function createCoordination({
  db,
  crm,
  events,
  insertMessage,
  body,
  json,
  audit,
  broadcast,
  content = null,
  payments = null,
  surveys = null,
  now = Date.now,
}) {
  let calendarOf = () => simulatedCalendar;
  const useCalendar = fn => {
    calendarOf = fn;
  };
  const defaults = b => ({
    brand_id: b,
    enabled: 0,
    auto_open: 1,
    reminder_hours: 24,
    charge_sessions: 1,
    survey_mode: 'off',
    revision: 0,
    updated_by: null,
    updated_at: null,
  });
  const settings = b => db.prepare('SELECT * FROM coordination_settings WHERE brand_id=?').get(b) || defaults(b);
  const roleOf = user => db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
  const requireStaff = user => {
    const u = roleOf(user);
    if (!u || u.disabled || !['admin', 'agent'].includes(u.role))
      throw fail(403, 'La coordinación es para el equipo de atención.');
  };
  const requireAdmin = user => {
    const u = roleOf(user);
    if (!u || u.disabled || u.role !== 'admin') throw fail(403, 'Esta acción requiere un administrador.');
  };
  // Cierres, cancelaciones y bajas: administración o la persona responsable de la apertura.
  const requireCloser = (user, e) => {
    const u = roleOf(user);
    if (!u || u.disabled) throw fail(403, 'Acceso no disponible.');
    if (u.role !== 'admin' && e.coordinator_id !== user.id)
      throw fail(403, 'Sólo administración o la persona responsable de la apertura puede hacerlo.');
  };
  const edition = id => {
    const e = db.prepare('SELECT * FROM editions WHERE id=?').get(id);
    if (!e) throw fail(404, 'Edición no disponible.');
    return e;
  };
  const session = id => {
    const s = db.prepare('SELECT * FROM edition_sessions WHERE id=?').get(id);
    if (!s) throw fail(404, 'Sesión no disponible.');
    return s;
  };
  const courseOf = e =>
    db.prepare('SELECT id,title FROM courses WHERE id=?').get(e.course_id) || { id: e.course_id, title: 'Curso' };
  const userName = id => (id ? db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name || null : null);
  const staffOf = brandId =>
    db
      .prepare(
        "SELECT id,name,role FROM users WHERE role IN ('admin','agent') AND COALESCE(disabled,0)=0 AND (role='admin' OR id IN (SELECT user_id FROM brand_members WHERE brand_id=?)) ORDER BY name",
      )
      .all(brandId);
  const enrolled = editionId =>
    db.prepare("SELECT count(*) n FROM enrollments WHERE edition_id=? AND status='enrolled'").get(editionId).n;
  const emit = (type, e, entityKind, entityId, payload, actor, source, dedupeKey) =>
    events.publish({
      type,
      brandId: e.brand_id,
      entityKind,
      entityId,
      payload,
      actorId: actor?.id || null,
      source,
      dedupeKey,
    });
  function notify(e, kind, title, key) {
    const t = now(),
      targets = e.coordinator_id ? [e.coordinator_id] : staffOf(e.brand_id).map(u => u.id);
    for (const id of targets)
      db.prepare(
        'INSERT OR IGNORE INTO notifications(id,user_id,brand_id,conversation_id,kind,title,event_key,created_at) VALUES(?,?,?,NULL,?,?,?,?)',
      ).run(randomUUID(), id, e.brand_id, kind, title, key, t);
  }
  // Pagos por sesión: crea las filas (sesión × inscripción con plan por sesión) que falten. La sesión cubierta por el pedido
  // de inscripción (la primera disponible al inscribirse, o la primera que se programe después) queda pagada con ese pedido;
  // el resto, pendiente con el precio por sesión vigente al crearse. Idempotente; dentro de una transacción.
  function ensurePayments(e) {
    const ens = db
      .prepare("SELECT * FROM enrollments WHERE edition_id=? AND status='enrolled' AND payment_plan='per_session'")
      .all(e.id);
    if (!ens.length) return;
    const sessions = db
        .prepare("SELECT * FROM edition_sessions WHERE edition_id=? AND status!='cancelled' ORDER BY starts_at,number")
        .all(e.id),
      t = now();
    for (const en of ens) {
      let covered = en.covered_session_id;
      if (!covered) {
        const next =
          sessions.find(x => x.status === 'scheduled' && x.starts_at + x.duration_min * 60000 > en.created_at) ||
          sessions.find(x => x.status === 'scheduled');
        if (next) {
          covered = next.id;
          db.prepare('UPDATE enrollments SET covered_session_id=? WHERE id=? AND covered_session_id IS NULL').run(
            covered,
            en.id,
          );
        }
      }
      const base = db.prepare('SELECT amount_cents,currency FROM orders WHERE id=?').get(en.order_id);
      for (const x of sessions) {
        if (x.status === 'done' && x.starts_at < en.created_at && x.id !== covered) continue; // sesiones realizadas antes de inscribirse: no se cobran
        const paid = x.id === covered;
        db.prepare(
          'INSERT OR IGNORE INTO session_payments(session_id,enrollment_id,brand_id,status,amount_cents,currency,order_id,paid_at,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          x.id,
          en.id,
          e.brand_id,
          paid ? 'paid' : 'pending',
          paid ? base.amount_cents : e.session_price_cents || 0,
          e.currency,
          paid ? en.order_id : null,
          paid ? t : null,
          paid ? 'Cubierta por el pedido de inscripción' : '',
          t,
          t,
        );
      }
    }
  }

  // ---- vistas
  function summary(e) {
    const c = courseOf(e),
      n = enrolled(e.id),
      t = now();
    const next =
      db
        .prepare(
          "SELECT id,number,title,starts_at,meet_url FROM edition_sessions WHERE edition_id=? AND status='scheduled' AND starts_at>=? ORDER BY starts_at LIMIT 1",
        )
        .get(e.id, t - 3600000) || null;
    const sessions = db
      .prepare('SELECT status,count(*) n FROM edition_sessions WHERE edition_id=? GROUP BY status')
      .all(e.id);
    const count = s => sessions.find(x => x.status === s)?.n || 0;
    return {
      id: e.id,
      brand_id: e.brand_id,
      course_id: e.course_id,
      courseTitle: c.title,
      name: e.name,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      timezone: e.timezone,
      modality: e.modality,
      instructor: e.instructor,
      status: e.status,
      legacy: e.legacy,
      capacity: e.capacity,
      available_seats: e.available_seats,
      session_price_cents: e.session_price_cents,
      currency: e.currency,
      perSession: db
        .prepare(
          "SELECT count(*) n FROM enrollments WHERE edition_id=? AND status='enrolled' AND payment_plan='per_session'",
        )
        .get(e.id).n,
      run_status: e.run_status,
      runLabel: RUN_STATUS[e.run_status],
      min_students: e.min_students,
      enrolled: n,
      progress: e.min_students > 0 ? Math.min(100, Math.round((n / e.min_students) * 100)) : null,
      missing: Math.max(0, e.min_students - n),
      coordinator_id: e.coordinator_id,
      coordinatorName: userName(e.coordinator_id),
      group_url: e.group_url,
      run_note: e.run_note,
      run_revision: e.run_revision,
      run_updated_at: e.run_updated_at,
      sessions: { scheduled: count('scheduled'), done: count('done'), cancelled: count('cancelled') },
      nextSession: next,
      transitions: TRANSITIONS[e.run_status],
    };
  }
  const order = { running: 0, open: 1, planned: 2, closed: 3, cancelled: 4 };
  function overview(user, { brand, status }) {
    requireStaff(user);
    const ids = crm
      .brandsFor(user)
      .map(b => b.id)
      .filter(id => !brand || brand === 'all' || id === brand);
    if (!ids.length) return { editions: [], settings: [], stats: {} };
    const ph = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT * FROM editions WHERE brand_id IN (${ph}) AND status!='archived'${status && RUN_STATUS[status] ? ' AND run_status=?' : ''}`,
      )
      .all(...ids, ...(status && RUN_STATUS[status] ? [status] : []))
      .map(summary)
      .sort(
        (a, b) =>
          order[a.run_status] - order[b.run_status] ||
          (a.starts_at ?? Infinity) - (b.starts_at ?? Infinity) ||
          a.courseTitle.localeCompare(b.courseTitle),
      );
    const stats = {};
    for (const k of Object.keys(RUN_STATUS))
      stats[k] = db
        .prepare(`SELECT count(*) n FROM editions WHERE brand_id IN (${ph}) AND status!='archived' AND run_status=?`)
        .get(...ids, k).n;
    stats.enrolled = db
      .prepare(`SELECT count(*) n FROM enrollments WHERE brand_id IN (${ph}) AND status='enrolled'`)
      .get(...ids).n;
    stats.upcoming = db
      .prepare(
        `SELECT count(*) n FROM edition_sessions WHERE brand_id IN (${ph}) AND status='scheduled' AND starts_at>=?`,
      )
      .get(...ids, now()).n;
    stats.sessionDue = db
      .prepare(
        `SELECT count(*) n FROM session_payments sp JOIN edition_sessions s ON s.id=sp.session_id WHERE sp.brand_id IN (${ph}) AND sp.status='pending' AND s.status='scheduled'`,
      )
      .get(...ids).n;
    stats.surveyAnswers = db
      .prepare(
        `SELECT count(*) n FROM survey_answers a JOIN surveys sv ON sv.id=a.survey_id WHERE sv.brand_id IN (${ph})`,
      )
      .get(...ids).n;
    return {
      editions: rows,
      settings: ids.map(id => ({
        ...settings(id),
        brand_name: db.prepare('SELECT name FROM brands WHERE id=?').get(id)?.name,
      })),
      stats,
      statuses: RUN_STATUS,
    };
  }
  const attendanceOf = sessionId =>
    db
      .prepare(
        'SELECT a.*,u.name marked_by_name FROM attendance a LEFT JOIN users u ON u.id=a.marked_by WHERE a.session_id=?',
      )
      .all(sessionId);
  const sessionView = s => {
    const marks = attendanceOf(s.id),
      tally = { present: 0, absent: 0, late: 0, excused: 0 };
    for (const m of marks) tally[m.status]++;
    return {
      ...s,
      statusLabel: { scheduled: 'Programada', done: 'Realizada', cancelled: 'Cancelada' }[s.status],
      attendance: {
        ...tally,
        marks: Object.fromEntries(marks.map(m => [m.enrollment_id, { status: m.status, note: m.note }])),
      },
    };
  };
  function detail(e, user) {
    requireStaff(user);
    crm.requireBrand(user, e.brand_id);
    transaction(db, () => ensurePayments(e));
    const enrollments = db
      .prepare(
        `SELECT en.id,en.status,en.created_at,en.cancelled_at,en.cancel_reason,en.payment_plan,en.covered_session_id,o.reference,o.amount_cents,o.currency,o.paid_at,o.method,o.conversation_id,c.name contact_name,c.phone,c.email,
      (SELECT count(*) FROM attendance a JOIN edition_sessions s ON s.id=a.session_id WHERE a.enrollment_id=en.id AND a.status IN ('present','late')) attended,(SELECT count(*) FROM edition_sessions s WHERE s.edition_id=en.edition_id AND s.status='done') held,
      (SELECT count(*) FROM session_payments sp WHERE sp.enrollment_id=en.id AND sp.status='paid') paidSessions,(SELECT count(*) FROM session_payments sp JOIN edition_sessions s2 ON s2.id=sp.session_id WHERE sp.enrollment_id=en.id AND sp.status='pending' AND s2.status='scheduled') pendingSessions
      FROM enrollments en JOIN orders o ON o.id=en.order_id JOIN contacts c ON c.id=en.contact_id WHERE en.edition_id=? ORDER BY en.status,en.created_at`,
      )
      .all(e.id);
    const sessions = db
      .prepare('SELECT * FROM edition_sessions WHERE edition_id=? ORDER BY starts_at,number')
      .all(e.id)
      .map(sessionView);
    const resources = db
      .prepare(
        'SELECT r.*,u.name created_by_name,l.filename FROM edition_resources r LEFT JOIN users u ON u.id=r.created_by LEFT JOIN library_files l ON l.id=r.file_id WHERE r.edition_id=? ORDER BY r.created_at DESC',
      )
      .all(e.id)
      .map(r => ({
        ...r,
        kindLabel: RESOURCE_KINDS[r.kind],
        fileUrl: r.file_id ? '/api/library/files/' + r.file_id : null,
      }));
    const recent = events.list([e.brand_id], { entityId: e.id, limit: 40 });
    const sessionPayments = db
      .prepare(
        "SELECT sp.*,s.number session_number,s.status session_status,o.reference order_reference,(SELECT x.reference FROM orders x WHERE x.session_id=sp.session_id AND x.enrollment_id=sp.enrollment_id AND x.status IN ('pending','review') LIMIT 1) open_reference FROM session_payments sp JOIN edition_sessions s ON s.id=sp.session_id LEFT JOIN orders o ON o.id=sp.order_id WHERE s.edition_id=? ORDER BY s.starts_at,s.number",
      )
      .all(e.id);
    return {
      edition: summary(e),
      enrollments,
      sessions,
      resources,
      events: recent,
      settings: settings(e.brand_id),
      staff: staffOf(e.brand_id),
      canClose: (() => {
        try {
          requireCloser(user, e);
          return true;
        } catch {
          return false;
        }
      })(),
      attendanceStatuses: ATTENDANCE,
      resourceKinds: RESOURCE_KINDS,
      sessionPayments,
      paymentsEnabled: Boolean(payments?.settings(e.brand_id).enabled),
      surveys: surveys ? surveys.results(e) : [],
      surveyModes: SURVEY_MODES,
    };
  }

  // ---- apertura
  function updateRun(e, input, user) {
    requireStaff(user);
    crm.requireBrand(user, e.brand_id);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== e.run_revision)
      throw fail(409, 'La apertura cambió. Recárgala.');
    const min = input.minStudents === undefined ? e.min_students : Number(input.minStudents);
    if (!Number.isInteger(min) || min < 0 || min > 500) throw fail(400, 'El mínimo de alumnos va de 0 a 500.');
    let coordinator = input.coordinatorId === undefined ? e.coordinator_id : text(input.coordinatorId, 60) || null;
    if (coordinator && !staffOf(e.brand_id).some(u => u.id === coordinator))
      throw fail(400, 'La persona responsable debe tener acceso a la marca.');
    // Quien es responsable puede cerrar, cancelar y dar bajas: la designación la hace administración (o la responsable actual al delegar), no cualquier integrante.
    if (coordinator !== e.coordinator_id) {
      const u = roleOf(user);
      if (u.role !== 'admin' && (!e.coordinator_id || e.coordinator_id !== user.id))
        throw fail(
          403,
          'Sólo administración o la persona responsable actual puede cambiar la responsable de la apertura.',
        );
    }
    const group = input.groupUrl === undefined ? e.group_url : url(input.groupUrl),
      note = input.note === undefined ? e.run_note : text(input.note, 1000),
      t = now();
    db.prepare(
      'UPDATE editions SET min_students=?,coordinator_id=?,group_url=?,run_note=?,run_revision=run_revision+1,run_updated_at=? WHERE id=?',
    ).run(min, coordinator, group, note, t, e.id);
    audit(user, 'coordination.edition.update', e.id);
    broadcast('crm', null, { brandId: e.brand_id });
    return summary(edition(e.id));
  }
  function transition(e, to, input, user) {
    requireStaff(user);
    crm.requireBrand(user, e.brand_id);
    if (!RUN_STATUS[to]) throw fail(400, 'Estado no válido.');
    if (!TRANSITIONS[e.run_status].includes(to))
      throw fail(409, 'De «' + RUN_STATUS[e.run_status] + '» no se pasa a «' + RUN_STATUS[to] + '».');
    if (['closed', 'cancelled'].includes(to)) requireCloser(user, e);
    const reason = text(input.reason, 500);
    if (to === 'cancelled' && reason.length < 5)
      throw fail(400, 'Indica el motivo de la cancelación (mínimo 5 caracteres).');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== e.run_revision)
      throw fail(409, 'La apertura cambió. Recárgala.');
    const t = now(),
      n = enrolled(e.id),
      c = courseOf(e);
    transaction(db, () => {
      if (
        !db
          .prepare(
            'UPDATE editions SET run_status=?,run_revision=run_revision+1,run_updated_at=? WHERE id=? AND run_status=?',
          )
          .run(to, t, e.id, e.run_status).changes
      )
        throw fail(409, 'La apertura cambió de estado. Recárgala.');
      const type = {
        open: 'apertura.abierta',
        running: 'apertura.en_curso',
        closed: 'apertura.cerrada',
        cancelled: 'apertura.cancelada',
      }[to];
      if (type)
        emit(
          type,
          e,
          'edition',
          e.id,
          {
            courseId: e.course_id,
            courseTitle: c.title,
            editionName: e.name,
            enrolled: n,
            minStudents: e.min_students,
            reason: reason || undefined,
            auto: false,
            sessions: db
              .prepare("SELECT count(*) n FROM edition_sessions WHERE edition_id=? AND status='done'")
              .get(e.id).n,
          },
          user,
          'coordination',
          type + ':' + e.id + ':' + t,
        );
      if (to === 'cancelled') {
        db.prepare(
          "UPDATE edition_sessions SET status='cancelled',revision=revision+1,updated_at=? WHERE edition_id=? AND status='scheduled'",
        ).run(t, e.id);
        db.prepare(
          "UPDATE session_payments SET status='waived',note='Apertura cancelada',updated_at=? WHERE status='pending' AND session_id IN (SELECT id FROM edition_sessions WHERE edition_id=?)",
        ).run(t, e.id);
        payments?.voidSessionOrders({ editionId: e.id }, 'Apertura cancelada: ' + reason, user);
      }
      if (['open', 'running'].includes(to))
        for (const r of db
          .prepare(
            "SELECT id FROM edition_sessions WHERE edition_id=? AND status='scheduled' AND reminder_sent_at IS NULL",
          )
          .all(e.id))
          remindIfDue(session(r.id), { ...e, run_status: to });
      notify(
        e,
        'coordination',
        (to === 'cancelled' ? 'Apertura cancelada' : 'Apertura ' + RUN_STATUS[to].toLowerCase()) +
          ' · ' +
          c.title +
          ' · ' +
          e.name,
        'edition:' + e.id + ':' + to + ':' + t,
      );
    });
    audit(user, 'coordination.edition.' + to, e.id);
    broadcast('crm', null, { brandId: e.brand_id });
    return summary(edition(e.id));
  }

  // ---- sesiones
  const windowMs = brandId => {
    const s = settings(brandId);
    return s.enabled ? s.reminder_hours * 3600000 : 0;
  };
  // Dentro de una transacción: si la sesión ya cae dentro de la ventana de recordatorio, se marca y se publica ahora;
  // el reloj (tick) hace lo mismo con las que entran en la ventana después. Una clave por sesión y fecha.
  function remindIfDue(s, e) {
    const w = windowMs(e.brand_id),
      t = now();
    if (
      !w ||
      s.status !== 'scheduled' ||
      s.reminder_sent_at ||
      !['open', 'running'].includes(e.run_status) ||
      s.starts_at <= t ||
      s.starts_at > t + w
    )
      return false;
    if (
      !db.prepare('UPDATE edition_sessions SET reminder_sent_at=? WHERE id=? AND reminder_sent_at IS NULL').run(t, s.id)
        .changes
    )
      return false;
    const c = courseOf(e);
    emit(
      'sesion.proxima',
      e,
      'session',
      s.id,
      {
        editionId: e.id,
        courseTitle: c.title,
        editionName: e.name,
        number: s.number,
        title: s.title,
        startsAt: s.starts_at,
        students: enrolled(e.id),
      },
      null,
      'coordination.clock',
      'sesion.proxima:' + s.id + ':' + s.starts_at,
    );
    return true;
  }
  const openForWork = e => {
    if (['closed', 'cancelled'].includes(e.run_status))
      throw fail(409, 'La apertura está ' + RUN_STATUS[e.run_status].toLowerCase() + '.');
  };
  async function createSession(e, input, user) {
    requireStaff(user);
    crm.requireBrand(user, e.brand_id);
    openForWork(e);
    const starts = when(input.startsAt);
    if (starts === null) throw fail(400, 'Indica fecha y hora de la sesión.');
    const duration = input.durationMin === undefined ? 90 : Number(input.durationMin);
    if (!Number.isInteger(duration) || duration < 15 || duration > 600)
      throw fail(400, 'La duración va de 15 a 600 minutos.');
    if (db.prepare('SELECT count(*) n FROM edition_sessions WHERE edition_id=?').get(e.id).n >= 200)
      throw fail(409, 'Máximo 200 sesiones por apertura.');
    const number = (db.prepare('SELECT max(number) n FROM edition_sessions WHERE edition_id=?').get(e.id).n || 0) + 1,
      title = text(input.title, 120) || 'Sesión ' + number,
      c = courseOf(e);
    let meet = { url: url(input.meetUrl), provider: 'manual' };
    if (!meet.url && input.createMeet) {
      const cal = calendarOf();
      const r = await cal.createEvent({
        title: c.title + ' · ' + title,
        startsAt: starts,
        durationMin: duration,
        description: e.name,
      });
      meet = { url: String(r.url || '').slice(0, 500), provider: cal.name };
    }
    if (!meet.url) meet.provider = 'none';
    const t = now(),
      id = randomUUID();
    transaction(db, () => {
      db.prepare(
        "INSERT INTO edition_sessions(id,edition_id,brand_id,number,title,starts_at,duration_min,meet_url,meet_provider,recording_url,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'','scheduled',?,?,?)",
      ).run(id, e.id, e.brand_id, number, title, starts, duration, meet.url, meet.provider, user.id, t, t);
      emit(
        'sesion.programada',
        e,
        'session',
        id,
        {
          editionId: e.id,
          courseTitle: c.title,
          editionName: e.name,
          number,
          title,
          startsAt: starts,
          durationMin: duration,
          meet: Boolean(meet.url),
        },
        user,
        'coordination',
      );
      remindIfDue(session(id), e);
      ensurePayments(e);
    });
    audit(user, 'coordination.session.create', id);
    broadcast('crm', null, { brandId: e.brand_id });
    return sessionView(session(id));
  }
  function updateSession(s, input, user) {
    const e = edition(s.edition_id);
    requireStaff(user);
    crm.requireBrand(user, e.brand_id);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== s.revision)
      throw fail(409, 'La sesión cambió. Recárgala.');
    if (s.status !== 'scheduled' && (input.startsAt !== undefined || input.durationMin !== undefined))
      throw fail(409, 'Una sesión realizada o cancelada no cambia de fecha.');
    const starts = input.startsAt === undefined ? s.starts_at : when(input.startsAt);
    if (starts === null) throw fail(400, 'Fecha y hora no válidas.');
    const duration = input.durationMin === undefined ? s.duration_min : Number(input.durationMin);
    if (!Number.isInteger(duration) || duration < 15 || duration > 600)
      throw fail(400, 'La duración va de 15 a 600 minutos.');
    const title = input.title === undefined ? s.title : text(input.title, 120) || s.title,
      meet = input.meetUrl === undefined ? s.meet_url : url(input.meetUrl),
      rec = input.recordingUrl === undefined ? s.recording_url : url(input.recordingUrl),
      t = now();
    transaction(db, () => {
      db.prepare(
        "UPDATE edition_sessions SET title=?,starts_at=?,duration_min=?,meet_url=?,meet_provider=CASE WHEN ?=meet_url THEN meet_provider WHEN ?='' THEN 'none' ELSE 'manual' END,recording_url=?,reminder_sent_at=CASE WHEN ?=starts_at THEN reminder_sent_at ELSE NULL END,revision=revision+1,updated_at=? WHERE id=?",
      ).run(title, starts, duration, meet, meet, meet, rec, starts, t, s.id);
      remindIfDue(session(s.id), e);
    });
    audit(user, 'coordination.session.update', s.id);
    broadcast('crm', null, { brandId: e.brand_id });
    return sessionView(session(s.id));
  }
  async function sessionMeet(s, user) {
    const e = edition(s.edition_id);
    requireStaff(user);
    crm.requireBrand(user, e.brand_id);
    if (s.status !== 'scheduled') throw fail(409, 'La sesión ya no está programada.');
    const cal = calendarOf(),
      c = courseOf(e),
      r = await cal.createEvent({
        title: c.title + ' · ' + s.title,
        startsAt: s.starts_at,
        durationMin: s.duration_min,
        description: e.name,
      });
    db.prepare(
      "UPDATE edition_sessions SET meet_url=?,meet_provider=?,revision=revision+1,updated_at=? WHERE id=? AND status='scheduled'",
    ).run(String(r.url || '').slice(0, 500), cal.name, now(), s.id);
    audit(user, 'coordination.session.meet', s.id);
    broadcast('crm', null, { brandId: e.brand_id });
    return sessionView(session(s.id));
  }
  function sessionStatus(s, to, input, user) {
    const e = edition(s.edition_id);
    requireStaff(user);
    crm.requireBrand(user, e.brand_id);
    if (!['done', 'cancelled'].includes(to)) throw fail(400, 'Estado no válido.');
    if (s.status !== 'scheduled')
      throw fail(409, 'La sesión ya está ' + (s.status === 'done' ? 'realizada' : 'cancelada') + '.');
    const reason = text(input.reason, 500);
    if (to === 'cancelled' && reason.length < 5) throw fail(400, 'Indica el motivo (mínimo 5 caracteres).');
    const t = now(),
      c = courseOf(e),
      v = sessionView(s);
    transaction(db, () => {
      if (
        !db
          .prepare(
            "UPDATE edition_sessions SET status=?,revision=revision+1,updated_at=? WHERE id=? AND status='scheduled'",
          )
          .run(to, t, s.id).changes
      )
        throw fail(409, 'La sesión cambió. Recárgala.');
      if (to === 'done')
        emit(
          'sesion.realizada',
          e,
          'session',
          s.id,
          {
            editionId: e.id,
            courseTitle: c.title,
            number: s.number,
            title: s.title,
            present: v.attendance.present + v.attendance.late,
            absent: v.attendance.absent,
          },
          user,
          'coordination',
        );
      else {
        emit(
          'sesion.cancelada',
          e,
          'session',
          s.id,
          { editionId: e.id, courseTitle: c.title, number: s.number, title: s.title, reason },
          user,
          'coordination',
        );
        db.prepare(
          "UPDATE session_payments SET status='waived',note='Sesión cancelada',updated_at=? WHERE session_id=? AND status='pending'",
        ).run(t, s.id);
        payments?.voidSessionOrders({ sessionId: s.id }, 'Sesión cancelada: ' + reason, user);
      }
    });
    audit(user, 'coordination.session.' + to, s.id);
    broadcast('crm', null, { brandId: e.brand_id });
    return sessionView(session(s.id));
  }
  function markAttendance(s, input, user) {
    const e = edition(s.edition_id);
    requireStaff(user);
    crm.requireBrand(user, e.brand_id);
    if (s.status === 'cancelled') throw fail(409, 'La sesión está cancelada.');
    const marks = Array.isArray(input.marks) ? input.marks.slice(0, 500) : [];
    if (!marks.length) throw fail(400, 'No hay asistencia que registrar.');
    const valid = new Set(
        db
          .prepare("SELECT id FROM enrollments WHERE edition_id=? AND status='enrolled'")
          .all(e.id)
          .map(r => r.id),
      ),
      t = now();
    transaction(db, () => {
      for (const m of marks) {
        const id = text(m.enrollmentId, 60);
        if (!valid.has(id)) throw fail(400, 'Una inscripción no pertenece a esta apertura o está cancelada.');
        if (!ATTENDANCE[m.status]) throw fail(400, 'Estado de asistencia no válido.');
        db.prepare(
          'INSERT INTO attendance(session_id,enrollment_id,status,note,marked_by,marked_at) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,enrollment_id) DO UPDATE SET status=excluded.status,note=excluded.note,marked_by=excluded.marked_by,marked_at=excluded.marked_at',
        ).run(s.id, id, m.status, text(m.note, 200), user.id, t);
      }
      const v = sessionView(s);
      emit(
        'asistencia.registrada',
        e,
        'session',
        s.id,
        {
          editionId: e.id,
          number: s.number,
          title: s.title,
          ...{
            present: v.attendance.present,
            absent: v.attendance.absent,
            late: v.attendance.late,
            excused: v.attendance.excused,
          },
        },
        user,
        'coordination',
        'asistencia.registrada:' + s.id + ':' + t,
      );
    });
    audit(user, 'coordination.attendance', s.id);
    broadcast('crm', null, { brandId: e.brand_id });
    return sessionView(session(s.id));
  }

  // ---- recursos e inscripciones
  function addResource(e, input, user) {
    requireStaff(user);
    crm.requireBrand(user, e.brand_id);
    const kind = String(input.kind || '');
    if (!RESOURCE_KINDS[kind]) throw fail(400, 'Tipo de recurso no válido.');
    const title = text(input.title, 140);
    if (title.length < 2) throw fail(400, 'Escribe el título del recurso.');
    const link = url(input.url),
      fileId = text(input.fileId, 60) || null;
    if (fileId && !db.prepare('SELECT 1 FROM library_files WHERE id=? AND brand_id=?').get(fileId, e.brand_id))
      throw fail(404, 'El archivo no pertenece a la biblioteca de la marca.');
    if (!link && !fileId) throw fail(400, 'Indica un enlace o elige un archivo de la biblioteca.');
    const sessionId = text(input.sessionId, 60) || null;
    if (sessionId && !db.prepare('SELECT 1 FROM edition_sessions WHERE id=? AND edition_id=?').get(sessionId, e.id))
      throw fail(404, 'La sesión no pertenece a esta apertura.');
    if (db.prepare('SELECT count(*) n FROM edition_resources WHERE edition_id=?').get(e.id).n >= 300)
      throw fail(409, 'Máximo 300 recursos por apertura.');
    const id = randomUUID();
    db.prepare(
      'INSERT INTO edition_resources(id,edition_id,brand_id,session_id,kind,title,url,file_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(id, e.id, e.brand_id, sessionId, kind, title, link, fileId, user.id, now());
    if (kind === 'recording' && sessionId && link)
      db.prepare(
        "UPDATE edition_sessions SET recording_url=CASE WHEN recording_url='' THEN ? ELSE recording_url END,updated_at=? WHERE id=?",
      ).run(link, now(), sessionId);
    if (kind === 'recording')
      emit(
        'grabacion.disponible',
        e,
        'resource',
        id,
        { editionId: e.id, sessionId, title, url: link || null, fileId },
        user,
        'coordination',
      ); // Contenido avisa a los inscritos sólo si la marca tiene plantilla mapeada
    audit(user, 'coordination.resource.create', id);
    broadcast('crm', null, { brandId: e.brand_id });
    return id;
  }
  function removeResource(id, user) {
    const r = db.prepare('SELECT * FROM edition_resources WHERE id=?').get(id);
    if (!r) throw fail(404, 'Recurso no encontrado.');
    requireStaff(user);
    crm.requireBrand(user, r.brand_id);
    db.prepare('DELETE FROM edition_resources WHERE id=?').run(id);
    audit(user, 'coordination.resource.delete', id);
    broadcast('crm', null, { brandId: r.brand_id });
    return true;
  }
  function cancelEnrollment(id, input, user) {
    const en = db.prepare('SELECT * FROM enrollments WHERE id=?').get(id);
    if (!en) throw fail(404, 'Inscripción no encontrada.');
    const e = edition(en.edition_id);
    requireStaff(user);
    crm.requireBrand(user, e.brand_id);
    requireCloser(user, e);
    const reason = text(input.reason, 500);
    if (reason.length < 5) throw fail(400, 'Indica el motivo de la baja (mínimo 5 caracteres).');
    if (en.status !== 'enrolled') throw fail(409, 'La inscripción ya estaba cancelada.');
    const t = now(),
      c = courseOf(e);
    transaction(db, () => {
      if (
        !db
          .prepare(
            "UPDATE enrollments SET status='cancelled',cancelled_at=?,cancel_reason=? WHERE id=? AND status='enrolled'",
          )
          .run(t, reason, id).changes
      )
        throw fail(409, 'La inscripción cambió. Recárgala.');
      const seatsBefore = db.prepare('SELECT available_seats s FROM editions WHERE id=?').get(e.id)?.s;
      db.prepare(
        'UPDATE editions SET available_seats=available_seats+1,updated_at=? WHERE id=? AND available_seats IS NOT NULL AND (capacity IS NULL OR available_seats<capacity)',
      ).run(t, e.id);
      {
        const ed = db.prepare('SELECT * FROM editions WHERE id=?').get(e.id);
        publishSeatChange(events, ed, seatsBefore, ed?.available_seats, {
          reason: 'baja',
          actorId: user?.id || null,
          source: 'coordination',
          dedupeKey: 'enrollment-cancel:' + id,
        });
      }
      db.prepare(
        "UPDATE session_payments SET status='waived',note='Baja de la inscripción',updated_at=? WHERE enrollment_id=? AND status='pending'",
      ).run(t, id);
      payments?.voidSessionOrders({ enrollmentId: id }, 'Baja de la inscripción: ' + reason, user);
      emit(
        'inscripcion.cancelada',
        e,
        'enrollment',
        id,
        {
          orderId: en.order_id,
          editionId: e.id,
          courseId: e.course_id,
          courseTitle: c.title,
          contactId: en.contact_id,
          reason,
        },
        user,
        'coordination',
      );
      notify(
        e,
        'coordination',
        'Baja de inscripción · ' + c.title + ' · ' + e.name + ' · ' + enrolled(e.id) + ' inscritos',
        'enrollment:' + id + ':cancelled',
      );
    });
    audit(user, 'coordination.enrollment.cancel', id);
    broadcast('crm', null, { brandId: e.brand_id });
    return summary(edition(e.id));
  }
  function setSettings(brandId, input, user) {
    requireAdmin(user);
    if (!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId)) throw fail(404, 'Marca no encontrada.');
    const current = settings(brandId);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.revision)
      throw fail(409, 'La configuración de coordinación cambió. Recárgala.');
    const hours = input.reminderHours === undefined ? current.reminder_hours : Number(input.reminderHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168)
      throw fail(400, 'El recordatorio se envía entre 1 y 168 horas antes.');
    const enabled = input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
      autoOpen = input.autoOpen === undefined ? current.auto_open : input.autoOpen ? 1 : 0,
      charge = input.chargeSessions === undefined ? current.charge_sessions : input.chargeSessions ? 1 : 0,
      t = now();
    const mode = input.surveyMode === undefined ? current.survey_mode : String(input.surveyMode);
    if (!SURVEY_MODES[mode]) throw fail(400, 'Modo de encuesta no válido.');
    db.prepare(
      'INSERT INTO coordination_settings(brand_id,enabled,auto_open,reminder_hours,charge_sessions,survey_mode,revision,updated_by,updated_at) VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(brand_id) DO UPDATE SET enabled=excluded.enabled,auto_open=excluded.auto_open,reminder_hours=excluded.reminder_hours,charge_sessions=excluded.charge_sessions,survey_mode=excluded.survey_mode,revision=coordination_settings.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
    ).run(brandId, enabled, autoOpen, hours, charge, mode, user.id, t);
    audit(user, 'coordination.settings', brandId);
    broadcast('crm', null, { brandId });
    return settings(brandId);
  }

  // ---- pagos por sesión y encuestas (acciones del equipo)
  const enrollmentIn = (e, id) => {
    const en = db.prepare('SELECT * FROM enrollments WHERE id=? AND edition_id=?').get(text(id, 60), e.id);
    if (!en) throw fail(404, 'La inscripción no pertenece a esta apertura.');
    return en;
  };
  const paymentsOf = (s, en) =>
    db.prepare('SELECT * FROM session_payments WHERE session_id=? AND enrollment_id=?').get(s.id, en.id);
  function charge(s, input, user) {
    const e = edition(s.edition_id);
    requireStaff(user);
    crm.requireBrand(user, e.brand_id);
    if (!payments) throw fail(409, 'Pagos no disponible.');
    const en = enrollmentIn(e, input.enrollmentId);
    let made;
    transaction(db, () => {
      ensurePayments(e);
      made = payments.sendSessionLink(s, en, { user, source: 'agent' });
    });
    audit(user, 'coordination.session.charge', s.id);
    broadcast('conversation', made.conversation.id);
    broadcast('crm', null, { brandId: e.brand_id });
    return { order: payments.view(made.order), created: made.created, payment: paymentsOf(s, en) };
  }
  function waive(s, input, user) {
    const e = edition(s.edition_id);
    requireStaff(user);
    crm.requireBrand(user, e.brand_id);
    requireCloser(user, e);
    const en = enrollmentIn(e, input.enrollmentId),
      note = text(input.note, 300);
    if (note.length < 5) throw fail(400, 'Indica el motivo de la condonación (mínimo 5 caracteres).');
    const t = now();
    let sp;
    transaction(db, () => {
      ensurePayments(e);
      sp = paymentsOf(s, en);
      if (!sp || sp.status !== 'pending')
        throw fail(
          409,
          sp?.status === 'paid'
            ? 'La sesión ya está pagada.'
            : sp?.status === 'waived'
              ? 'La sesión ya estaba condonada.'
              : 'No hay cobro pendiente para esta sesión.',
        );
      payments?.voidSessionOrders({ sessionId: s.id, enrollmentId: en.id }, 'Sesión condonada: ' + note, user);
      db.prepare(
        "UPDATE session_payments SET status='waived',waived_by=?,note=?,updated_at=? WHERE session_id=? AND enrollment_id=? AND status='pending'",
      ).run(user.id, note, t, s.id, en.id);
      emit(
        'pago.condonado',
        e,
        'session',
        s.id,
        {
          editionId: e.id,
          enrollmentId: en.id,
          number: s.number,
          amountCents: sp.amount_cents,
          currency: sp.currency,
          note,
        },
        user,
        'coordination',
        'pago.condonado:' + s.id + ':' + en.id + ':' + t,
      );
    });
    audit(user, 'coordination.session.waive', s.id);
    broadcast('crm', null, { brandId: e.brand_id });
    return { payment: paymentsOf(s, en) };
  }
  function sendSurvey(e, input, user) {
    requireStaff(user);
    crm.requireBrand(user, e.brand_id);
    if (!surveys) throw fail(409, 'Encuestas no disponible.');
    return surveys.send(
      e,
      { kind: String(input.kind || ''), sessionId: text(input.sessionId, 60) || null },
      user,
      'coordination',
    );
  }

  // ---- suscriptores y reloj
  // La venta confirmada entra sola a la apertura: aviso a la persona responsable y, con la automatización activa,
  // la apertura pasa a «abierta» al llegar al mínimo. El evento ya existe; aquí sólo se reacciona (idempotente por clave).
  function onPaymentConfirmed(ev) {
    const e = db.prepare('SELECT * FROM editions WHERE id=?').get(ev.payload.editionId);
    if (!e) return;
    const c = courseOf(e),
      s = settings(e.brand_id),
      t = now();
    if (ev.payload.kind === 'session') {
      // pago de una sesión: la fila ya quedó pagada al confirmar; aquí sólo se avisa a la responsable
      const who = db.prepare('SELECT name FROM contacts WHERE id=?').get(ev.payload.contactId)?.name || 'Alumno';
      transaction(db, () =>
        notify(
          e,
          'coordination',
          'Pago de sesión ' + (ev.payload.sessionNumber || '') + ' · ' + who + ' · ' + c.title + ' · ' + e.name,
          'order:' + ev.entity_id + ':session-paid',
        ),
      );
      broadcast('crm', null, { brandId: e.brand_id });
      return;
    }
    transaction(db, () => {
      ensurePayments(e);
      const n = enrolled(e.id);
      notify(
        e,
        'coordination',
        'Nueva inscripción · ' +
          c.title +
          ' · ' +
          e.name +
          ' · ' +
          n +
          (e.min_students ? ' de ' + e.min_students : '') +
          ' inscritos',
        'enrollment:' + ev.payload.enrollmentId + ':new',
      );
      if (
        s.enabled &&
        s.auto_open &&
        e.run_status === 'planned' &&
        e.min_students > 0 &&
        n >= e.min_students &&
        db
          .prepare(
            "UPDATE editions SET run_status='open',run_revision=run_revision+1,run_updated_at=? WHERE id=? AND run_status='planned'",
          )
          .run(t, e.id).changes
      ) {
        emit(
          'apertura.abierta',
          e,
          'edition',
          e.id,
          {
            courseId: e.course_id,
            courseTitle: c.title,
            editionName: e.name,
            enrolled: n,
            minStudents: e.min_students,
            auto: true,
          },
          null,
          'coordination.auto',
          'apertura.abierta:' + e.id + ':auto',
        );
        notify(
          e,
          'coordination',
          'Apertura confirmada al llegar al mínimo · ' + c.title + ' · ' + e.name + ' · ' + n + ' inscritos',
          'edition:' + e.id + ':auto-open',
        );
      }
    });
    broadcast('crm', null, { brandId: e.brand_id });
  }
  // Recordatorio a cada inscrito por su conversación (plantilla de utilidad, dentro o fuera de la ventana). Un envío por
  // inscripción y sesión: el reintento del suscriptor no duplica mensajes.
  function onSessionDue(ev) {
    const s = db.prepare('SELECT * FROM edition_sessions WHERE id=?').get(ev.entity_id);
    if (!s || s.status !== 'scheduled') return;
    const e = edition(s.edition_id),
      c = courseOf(e);
    const rows = db
      .prepare(
        "SELECT en.id enrollment_id,o.conversation_id,(SELECT status FROM contact_consent k WHERE k.contact_id=en.contact_id) consent FROM enrollments en JOIN orders o ON o.id=en.order_id WHERE en.edition_id=? AND en.status='enrolled'",
      )
      .all(e.id);
    let sent = 0,
      skipped = 0;
    for (const r of rows) {
      if (r.consent === 'opted_out') {
        skipped++;
        continue;
      } // la baja de mensajes se respeta también en recordatorios; la persona coordinadora avisa por otro medio
      const ref = 'session:' + s.id + ':reminder:' + r.enrollment_id;
      if (db.prepare('SELECT 1 FROM messages WHERE client_ref=?').get(ref)) continue;
      const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(r.conversation_id);
      if (!conv || conv.status === 'resolved') continue;
      const first = db.prepare('SELECT name FROM users WHERE id=?').get(conv.customer_id)?.name?.split(' ')[0] || null;
      const tpl = content?.render('session_reminder', e.brand_id, {
        courseId: e.course_id,
        editionId: e.id,
        name: first,
        extra: {
          sesion: s.number + '. ' + s.title,
          fecha_sesion: stamp(s.starts_at, e.timezone) + ' (' + s.duration_min + ' min)',
          enlace_sesion: s.meet_url || '',
          grupo: e.group_url || '',
        },
      });
      const body = tpl
        ? tpl.text
        : `Recordatorio de clase · ${c.title} · ${e.name}\nSesión ${s.number}: ${s.title}\n${stamp(s.starts_at, e.timezone)} (${s.duration_min} min)\n${s.meet_url ? 'Enlace: ' + s.meet_url : 'El enlace de la videollamada se enviará por aquí.'}${e.group_url ? '\nGrupo del curso: ' + e.group_url : ''}\nLaboratorio: aviso de práctica.`;
      try {
        transaction(db, () =>
          insertMessage(conv, null, body, 'automation', ref, null, null, null, { category: 'utility' }),
        );
        sent++;
        broadcast('conversation', conv.id);
      } catch (err) {
        if (err?.status !== 409) throw err;
      }
    }
    if (skipped)
      notify(
        e,
        'coordination',
        'Recordatorio de «' +
          s.title +
          '»: ' +
          skipped +
          (skipped === 1 ? ' inscrito pidió' : ' inscritos pidieron') +
          ' no recibir mensajes; avísales por otro medio',
        'session:' + s.id + ':reminder-skipped',
      );
    // Plan por sesión: con el recordatorio sale el enlace de pago de la sesión a quien la tiene pendiente (si la marca cobra
    // sesiones y la venta con pago está activa). Un pedido por sesión e inscripción; el reintento no duplica.
    let charged = 0;
    const st = settings(e.brand_id);
    if (payments && st.charge_sessions && payments.settings(e.brand_id).enabled) {
      transaction(db, () => ensurePayments(e));
      for (const en of db
        .prepare(
          "SELECT en.*,(SELECT status FROM contact_consent k WHERE k.contact_id=en.contact_id) consent FROM enrollments en JOIN session_payments sp ON sp.enrollment_id=en.id AND sp.session_id=? AND sp.status='pending' WHERE en.edition_id=? AND en.status='enrolled' AND en.payment_plan='per_session'",
        )
        .all(s.id, e.id)) {
        if (en.consent === 'opted_out') continue;
        try {
          let made;
          transaction(db, () => {
            made = payments.sendSessionLink(s, en, { user: null, source: 'bot' });
          });
          if (made.created) {
            charged++;
            broadcast('conversation', made.conversation.id);
          }
        } catch (err) {
          if (err?.status !== 409) throw err;
        }
      }
    }
    return { sent, skipped, charged };
  }
  async function tick() {
    const t = now(),
      due = db
        .prepare(
          "SELECT s.id,s.edition_id FROM edition_sessions s JOIN editions e ON e.id=s.edition_id JOIN coordination_settings cs ON cs.brand_id=s.brand_id WHERE cs.enabled=1 AND s.status='scheduled' AND s.reminder_sent_at IS NULL AND e.run_status IN ('open','running') AND s.starts_at>? AND s.starts_at<=?+cs.reminder_hours*3600000 LIMIT 50",
        )
        .all(t, t);
    if (!due.length) return 0;
    let n = 0;
    transaction(db, () => {
      for (const r of due) if (remindIfDue(session(r.id), edition(r.edition_id))) n++;
    });
    return n;
  }
  events.subscribe('pago.confirmado', 'coordination.sale', onPaymentConfirmed);
  events.subscribe('sesion.proxima', 'coordination.reminder', onSessionDue);

  async function handle(req, res, path, user) {
    if (!path.startsWith('/api/coordination')) return false;
    const url = new URL(req.url, 'http://localhost');
    let x;
    if (path === '/api/coordination' && req.method === 'GET') {
      json(res, 200, overview(user, { brand: url.searchParams.get('brand'), status: url.searchParams.get('status') }));
      return true;
    }
    if ((x = path.match(/^\/api\/coordination\/brands\/([a-zA-Z0-9-]+)$/)) && req.method === 'PATCH') {
      json(res, 200, { settings: setSettings(x[1], await body(req), user) });
      return true;
    }
    if (
      (x = path.match(/^\/api\/coordination\/editions\/([a-zA-Z0-9-]+)(?:\/(status|sessions|resources|surveys))?$/))
    ) {
      const e = edition(x[1]);
      if (!x[2] && req.method === 'GET') {
        json(res, 200, detail(e, user));
        return true;
      }
      if (!x[2] && req.method === 'PATCH') {
        json(res, 200, { edition: updateRun(e, await body(req), user) });
        return true;
      }
      if (x[2] === 'status' && req.method === 'POST') {
        const input = await body(req);
        json(res, 200, { edition: transition(e, String(input.to || ''), input, user) });
        return true;
      }
      if (x[2] === 'sessions' && req.method === 'POST') {
        json(res, 201, { session: await createSession(e, await body(req), user) });
        return true;
      }
      if (x[2] === 'resources' && req.method === 'POST') {
        json(res, 201, { id: addResource(e, await body(req), user) });
        return true;
      }
      if (x[2] === 'surveys' && req.method === 'POST') {
        const r = sendSurvey(e, await body(req), user);
        json(res, 200, { survey: r.survey, sent: r.sent, skipped: r.skipped });
        return true;
      }
      throw fail(405, 'Método no permitido.');
    }
    if (
      (x = path.match(
        /^\/api\/coordination\/sessions\/([a-f0-9-]{36})(?:\/(meet|attendance|done|cancel|charge|waive))?$/,
      ))
    ) {
      const s = session(x[1]);
      if (!x[2] && req.method === 'PATCH') {
        json(res, 200, { session: updateSession(s, await body(req), user) });
        return true;
      }
      if (x[2] === 'meet' && req.method === 'POST') {
        json(res, 200, { session: await sessionMeet(s, user) });
        return true;
      }
      if (x[2] === 'attendance' && req.method === 'PUT') {
        json(res, 200, { session: markAttendance(s, await body(req), user) });
        return true;
      }
      if ((x[2] === 'done' || x[2] === 'cancel') && req.method === 'POST') {
        json(res, 200, { session: sessionStatus(s, x[2] === 'done' ? 'done' : 'cancelled', await body(req), user) });
        return true;
      }
      if (x[2] === 'charge' && req.method === 'POST') {
        json(res, 200, charge(s, await body(req), user));
        return true;
      }
      if (x[2] === 'waive' && req.method === 'POST') {
        json(res, 200, waive(s, await body(req), user));
        return true;
      }
      throw fail(405, 'Método no permitido.');
    }
    if ((x = path.match(/^\/api\/coordination\/resources\/([a-f0-9-]{36})$/)) && req.method === 'DELETE') {
      removeResource(x[1], user);
      json(res, 200, { ok: true });
      return true;
    }
    if ((x = path.match(/^\/api\/coordination\/enrollments\/([a-f0-9-]{36})\/cancel$/)) && req.method === 'POST') {
      json(res, 200, { edition: cancelEnrollment(x[1], await body(req), user) });
      return true;
    }
    throw fail(404, 'Ruta de coordinación no encontrada.');
  }
  return {
    handle,
    settings,
    summary,
    overview,
    detail,
    updateRun,
    transition,
    createSession,
    markAttendance,
    tick,
    useCalendar,
    onPaymentConfirmed,
    onSessionDue,
    ensurePayments,
    charge,
    waive,
  };
}
