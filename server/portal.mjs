// Portal por roles (Fase 5, bloque 2; docs/PLAN_PORTAL_ROLES.md). Vistas de sólo lectura y sin esquema propio: cada persona del
// equipo ve su trabajo (ventas y comisiones del libro de Finanzas, cartera de oportunidades, aperturas que coordina y avisos).
// No duplica reglas: lee las mismas tablas que Finanzas, el CRM y la coordinación académica. Administración puede ver a otra persona.
const fail = (status, message) => Object.assign(new Error(message), { status });
const DAY = 24 * 3600000,
  HOUR = 3600000;
const STAGES = ['nuevo', 'interesado', 'inscripcion'];
const money = (cents, currency = 'MXN') =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format((cents || 0) / 100);
const ph = a => a.map(() => '?').join(',') || 'NULL';

export function createPortal({ db, crm, json, now = Date.now }) {
  const staffRow = id => db.prepare('SELECT id,name,username,role,disabled FROM users WHERE id=?').get(id);
  const isStaff = u => Boolean(u) && !u.disabled && ['agent', 'admin'].includes(u.role);
  const brandName = id => db.prepare('SELECT name FROM brands WHERE id=?').get(id)?.name || id;

  // Quién mira y a quién: cada persona se ve a sí misma; administración puede mirar a cualquiera del equipo.
  function subject(user, params) {
    const me = staffRow(user.id);
    if (!isStaff(me)) throw fail(403, 'Esta vista es para el equipo de atención.');
    const wanted = params.get('person');
    if (!wanted || wanted === me.id) return { me, person: me };
    if (me.role !== 'admin') throw fail(403, 'Sólo administración puede ver el trabajo de otra persona.');
    const person = staffRow(wanted);
    if (!isStaff(person)) throw fail(404, 'Persona no disponible.');
    return { me, person };
  }
  // Marcas de la persona que se mira (el alcance por marca se aplica a su propio trabajo).
  const brandsOf = person =>
    person.role === 'admin'
      ? db
          .prepare('SELECT id FROM brands')
          .all()
          .map(b => b.id)
      : db
          .prepare('SELECT brand_id id FROM brand_members WHERE user_id=?')
          .all(person.id)
          .map(b => b.id);
  function period(params) {
    const days = Number(params.get('days') || 30);
    if (!Number.isInteger(days) || days < 1 || days > 400) throw fail(400, 'Elige un periodo de 1 a 400 días.');
    const to = now();
    return { days, from: to - days * DAY, to };
  }

  function sales(person, ids, p) {
    const rows = ids.length
      ? db
          .prepare(
            `SELECT * FROM ledger_entries WHERE seller_id=? AND brand_id IN (${ph(ids)}) AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at DESC,seq DESC`,
          )
          .all(person.id, ...ids, p.from, p.to)
      : [];
    const cur = rows[0]?.currency || 'MXN',
      s = rows.filter(r => r.kind === 'sale'),
      r = rows.filter(x => x.kind === 'refund'),
      sum = l => l.reduce((n, x) => n + x.amount_cents, 0);
    const group = (keyOf, labelOf) => {
      const m = new Map();
      for (const x of rows) {
        const k = keyOf(x);
        if (!k) continue;
        const b = m.get(k) || { key: k, label: labelOf(k), sales: 0, netCents: 0 };
        if (x.kind === 'sale') b.sales++;
        b.netCents += x.amount_cents;
        m.set(k, b);
      }
      return [...m.values()]
        .map(b => ({ ...b, netLabel: money(b.netCents, cur) }))
        .sort((a, b) => b.netCents - a.netCents);
    };
    const courseTitle = id => db.prepare('SELECT title FROM courses WHERE id=?').get(id)?.title || id;
    return {
      count: s.length,
      grossCents: sum(s),
      grossLabel: money(sum(s), cur),
      refunds: r.length,
      refundsCents: -sum(r),
      refundsLabel: money(-sum(r), cur),
      netCents: sum(rows),
      netLabel: money(sum(rows), cur),
      avgTicketCents: s.length ? Math.round(sum(s) / s.length) : 0,
      avgTicketLabel: money(s.length ? Math.round(sum(s) / s.length) : 0, cur),
      byBrand: group(x => x.brand_id, brandName),
      byCourse: group(x => x.course_id, courseTitle).slice(0, 5),
      recent: rows.slice(0, 10).map(x => ({
        id: x.id,
        kind: x.kind,
        at: x.occurred_at,
        amountCents: x.amount_cents,
        amountLabel: money(x.amount_cents, x.currency),
        method: x.method,
        brand: brandName(x.brand_id),
        course: x.course_id ? courseTitle(x.course_id) : null,
        edition: x.edition_id
          ? db.prepare('SELECT name FROM editions WHERE id=?').get(x.edition_id)?.name || null
          : null,
        contact: x.contact_id
          ? db.prepare('SELECT name FROM contacts WHERE id=?').get(x.contact_id)?.name || null
          : null,
      })),
    };
  }
  function commissions(person, ids, p) {
    const cur =
      db.prepare('SELECT currency FROM commission_entries WHERE user_id=? LIMIT 1').get(person.id)?.currency || 'MXN';
    const inPeriod = ids.length
      ? db
          .prepare(
            `SELECT c.status,sum(c.amount_cents) cents,count(*) n FROM commission_entries c JOIN ledger_entries l ON l.id=c.ledger_id WHERE c.user_id=? AND c.role='vendedor' AND l.brand_id IN (${ph(ids)}) AND l.occurred_at>=? AND l.occurred_at<? GROUP BY c.status`,
          )
          .all(person.id, ...ids, p.from, p.to)
      : [];
    const of = (s, k = 'cents') => inPeriod.find(x => x.status === s)?.[k] || 0;
    const pending = ids.length
      ? db
          .prepare(
            `SELECT sum(amount_cents) cents,count(*) n FROM commission_entries WHERE user_id=? AND role='vendedor' AND status='accrued' AND brand_id IN (${ph(ids)})`,
          )
          .get(person.id, ...ids)
      : { cents: 0, n: 0 };
    const payouts = db
      .prepare(
        "SELECT id,total_cents,currency,entries,note,paid_at FROM commission_payouts WHERE user_id=? AND role='vendedor' ORDER BY paid_at DESC LIMIT 5",
      )
      .all(person.id)
      .map(x => ({ ...x, totalLabel: money(x.total_cents, x.currency) }));
    const rule = db
      .prepare("SELECT percent_bp,fixed_cents FROM commission_rules WHERE role='vendedor' AND brand_id IS NULL")
      .get();
    return {
      accruedCents: of('accrued'),
      accruedLabel: money(of('accrued'), cur),
      paidCents: of('paid'),
      paidLabel: money(of('paid'), cur),
      pendingCents: pending.cents || 0,
      pendingLabel: money(pending.cents || 0, cur),
      pendingCount: pending.n || 0,
      payouts,
      rule: rule ? { percent: rule.percent_bp / 100, fixedLabel: money(rule.fixed_cents, cur) } : null,
    };
  }
  function pipeline(person, ids, p) {
    const t = now(),
      empty = {
        open: Object.fromEntries(STAGES.map(s => [s, 0])),
        openTotal: 0,
        won: 0,
        lost: 0,
        winRate: null,
        tasksOpen: 0,
        tasksOverdue: 0,
        chats: 0,
        waiting: 0,
      };
    if (!ids.length) return empty;
    const open = db
      .prepare(
        `SELECT stage,count(*) n FROM opportunities WHERE owner_id=? AND brand_id IN (${ph(ids)}) AND stage IN ('nuevo','interesado','inscripcion') GROUP BY stage`,
      )
      .all(person.id, ...ids);
    const closed = db
      .prepare(
        `SELECT stage,count(*) n FROM opportunities WHERE owner_id=? AND brand_id IN (${ph(ids)}) AND stage IN ('ganada','perdida') AND updated_at>=? AND updated_at<? GROUP BY stage`,
      )
      .all(person.id, ...ids, p.from, p.to);
    const won = closed.find(x => x.stage === 'ganada')?.n || 0,
      lost = closed.find(x => x.stage === 'perdida')?.n || 0;
    const tasks = db
      .prepare(
        `SELECT count(*) n,sum(CASE WHEN due_at<? THEN 1 ELSE 0 END) overdue FROM tasks WHERE owner_id=? AND status='open' AND brand_id IN (${ph(ids)})`,
      )
      .get(t, person.id, ...ids);
    const chats = db
      .prepare(
        `SELECT count(*) n,sum(CASE WHEN status='waiting' THEN 1 ELSE 0 END) waiting FROM conversations WHERE assigned_to=? AND status!='resolved' AND brand_id IN (${ph(ids)})`,
      )
      .get(person.id, ...ids);
    return {
      ...empty,
      open: { ...empty.open, ...Object.fromEntries(open.map(x => [x.stage, x.n])) },
      openTotal: open.reduce((n, x) => n + x.n, 0),
      won,
      lost,
      winRate: won + lost ? Math.round((won * 1000) / (won + lost)) / 10 : null,
      tasksOpen: tasks.n || 0,
      tasksOverdue: tasks.overdue || 0,
      chats: chats.n || 0,
      waiting: chats.waiting || 0,
    };
  }
  // Aperturas que la persona coordina y los avisos que piden su atención.
  function coordination(person, ids) {
    const t = now(),
      alerts = [];
    const rows = ids.length
      ? db
          .prepare(
            `SELECT e.*,k.title course_title FROM editions e JOIN courses k ON k.id=e.course_id WHERE e.coordinator_id=? AND e.brand_id IN (${ph(ids)}) AND (e.run_status IN ('planned','open','running') OR (e.run_status='closed' AND COALESCE(e.run_updated_at,0)>?)) ORDER BY CASE e.run_status WHEN 'running' THEN 0 WHEN 'open' THEN 1 WHEN 'planned' THEN 2 ELSE 3 END,COALESCE(e.starts_at,9e15)`,
          )
          .all(person.id, ...ids, t - 60 * DAY)
      : [];
    const editions = rows.map(e => {
      const enrolled = db
        .prepare("SELECT count(*) n FROM enrollments WHERE edition_id=? AND status='enrolled'")
        .get(e.id).n;
      const sessions = db
        .prepare(
          'SELECT id,number,title,starts_at,status,meet_url FROM edition_sessions WHERE edition_id=? ORDER BY starts_at',
        )
        .all(e.id);
      const upcoming = sessions.filter(s => s.status === 'scheduled' && s.starts_at >= t),
        done = sessions.filter(s => s.status === 'done');
      const certs = db
        .prepare("SELECT count(*) n FROM certificates WHERE edition_id=? AND status='issued'")
        .get(e.id).n;
      const sv = db
        .prepare(
          'SELECT count(*) n,avg(a.content_score) c,avg(a.instructor_score) i,avg(a.organization_score) o,avg(a.nps) nps FROM survey_answers a JOIN surveys s ON s.id=a.survey_id WHERE s.edition_id=?',
        )
        .get(e.id);
      const ref = { editionId: e.id, course: e.course_title, edition: e.name, brand: brandName(e.brand_id) },
        add = (level, text) => alerts.push({ ...ref, level, text });
      const days = e.starts_at ? Math.ceil((e.starts_at - t) / DAY) : null;
      if (
        ['planned', 'open'].includes(e.run_status) &&
        e.min_students > 0 &&
        enrolled < e.min_students &&
        days !== null &&
        days <= 7 &&
        days >= -1
      )
        add(
          days <= 3 ? 'urgent' : 'warn',
          'Faltan ' +
            (e.min_students - enrolled) +
            ' ' +
            (e.min_students - enrolled === 1 ? 'inscrito' : 'inscritos') +
            ' para el mínimo (' +
            e.min_students +
            ') y la edición ' +
            (days <= 0 ? 'empieza hoy' : 'empieza en ' + days + (days === 1 ? ' día' : ' días')) +
            '.',
        );
      if (['open', 'running'].includes(e.run_status) && !upcoming.length && !done.length)
        add('warn', 'Apertura sin sesiones programadas.');
      for (const s of done)
        if (enrolled > 0 && !db.prepare('SELECT 1 FROM attendance WHERE session_id=?').get(s.id))
          add('urgent', 'La sesión ' + s.number + ' ya se realizó y no tiene asistencia registrada.');
      const next = upcoming[0];
      if (next && next.starts_at - t <= 48 * HOUR && !next.meet_url)
        add('urgent', 'La sesión ' + next.number + ' es en menos de 48 h y no tiene enlace de videollamada.');
      if (e.run_status === 'closed' && enrolled > 0 && !certs)
        add('warn', 'Apertura cerrada con ' + enrolled + ' inscritos y sin certificados emitidos.');
      return {
        id: e.id,
        brand: brandName(e.brand_id),
        course: e.course_title,
        name: e.name,
        runStatus: e.run_status,
        startsAt: e.starts_at,
        minStudents: e.min_students,
        enrolled,
        capacity: e.capacity,
        nextSession: next
          ? { number: next.number, title: next.title, startsAt: next.starts_at, hasLink: Boolean(next.meet_url) }
          : null,
        sessionsDone: done.length,
        sessionsTotal: sessions.filter(s => s.status !== 'cancelled').length,
        certificates: certs,
        survey: sv.n
          ? {
              responses: sv.n,
              content: Math.round(sv.c * 10) / 10,
              instructor: Math.round(sv.i * 10) / 10,
              organization: Math.round(sv.o * 10) / 10,
              nps: Math.round(sv.nps * 10) / 10,
            }
          : null,
      };
    });
    alerts.sort((a, b) => (a.level === 'urgent' ? 0 : 1) - (b.level === 'urgent' ? 0 : 1));
    return { editions, alerts };
  }

  // Atención de la persona: respuestas humanas registradas en la bitácora de operación (primera respuesta y siguientes).
  function service(person, ids, p) {
    const empty = { responses: 0, medianMs: null, withinTargetPct: null, messages: 0 };
    if (!ids.length) return empty;
    const rows = db
      .prepare(
        `SELECT details FROM operation_events WHERE kind='response' AND actor_id=? AND brand_id IN (${ph(ids)}) AND created_at>=? AND created_at<?`,
      )
      .all(person.id, ...ids, p.from, p.to)
      .map(r => JSON.parse(r.details));
    const first = rows
      .filter(r => r.kind === 'first' && r.respondedAt && r.waitingSince)
      .map(r => Math.max(0, r.respondedAt - r.waitingSince))
      .sort((a, b) => a - b);
    const judged = rows.filter(r => r.withinTarget === true || r.withinTarget === false);
    const messages = db
      .prepare(
        `SELECT count(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.sender_id=? AND m.sender_kind='agent' AND c.brand_id IN (${ph(ids)}) AND m.created_at>=? AND m.created_at<?`,
      )
      .get(person.id, ...ids, p.from, p.to).n;
    return {
      responses: rows.length,
      medianMs: first.length ? first[Math.floor((first.length - 1) / 2)] : null,
      withinTargetPct: judged.length
        ? Math.round((judged.filter(r => r.withinTarget).length * 1000) / judged.length) / 10
        : null,
      messages,
    };
  }
  // Rendimiento del equipo (sólo administración): una fila por persona con las mismas definiciones que el portal personal.
  function team(user, params) {
    const me = staffRow(user.id);
    if (!isStaff(me) || me.role !== 'admin') throw fail(403, 'El rendimiento del equipo es para administración.');
    const p = period(params),
      brand = params.get('brand');
    let scope = db
      .prepare('SELECT id FROM brands')
      .all()
      .map(b => b.id);
    if (brand && brand !== 'all') {
      if (!scope.includes(brand)) throw fail(404, 'Marca o registro no disponible.');
      scope = [brand];
    }
    const rows = db
      .prepare("SELECT id,name,role FROM users WHERE role IN ('agent','admin') AND disabled=0 ORDER BY name")
      .all()
      .map(person => {
        const ids = brandsOf(person).filter(id => scope.includes(id));
        if (!ids.length) return null;
        const s = sales(person, ids, p),
          c = commissions(person, ids, p),
          pl = pipeline(person, ids, p),
          co = coordination(person, ids),
          sv = service(person, ids, p);
        return {
          id: person.id,
          name: person.name,
          role: person.role,
          brands: ids.map(brandName),
          sales: { count: s.count, netCents: s.netCents, netLabel: s.netLabel, avgTicketLabel: s.avgTicketLabel },
          commissionPendingCents: c.pendingCents,
          commissionPendingLabel: c.pendingLabel,
          pipeline: {
            openTotal: pl.openTotal,
            won: pl.won,
            lost: pl.lost,
            winRate: pl.winRate,
            tasksOpen: pl.tasksOpen,
            tasksOverdue: pl.tasksOverdue,
            chats: pl.chats,
            waiting: pl.waiting,
          },
          service: sv,
          coordination: {
            editions: co.editions.length,
            alerts: co.alerts.length,
            urgent: co.alerts.filter(a => a.level === 'urgent').length,
          },
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.sales.netCents - a.sales.netCents || a.name.localeCompare(b.name, 'es'));
    const net = rows.reduce((n, r) => n + r.sales.netCents, 0);
    return {
      period: { days: p.days, from: p.from, to: p.to },
      scope: { brands: scope.map(id => ({ id, name: brandName(id) })) },
      rows,
      totals: {
        people: rows.length,
        sales: rows.reduce((n, r) => n + r.sales.count, 0),
        netCents: net,
        netLabel: money(net),
        tasksOverdue: rows.reduce((n, r) => n + r.pipeline.tasksOverdue, 0),
        alerts: rows.reduce((n, r) => n + r.coordination.alerts, 0),
      },
      notes: [
        'Cada fila usa las mismas definiciones que «Mis resultados» de esa persona. Las ventas se atribuyen a quien tenía la oportunidad al confirmarse el pago; las ventas del motor de respuestas no tienen vendedor.',
      ],
    };
  }

  function overview(user, params) {
    const { me, person } = subject(user, params),
      p = period(params),
      brand = params.get('brand');
    let ids = brandsOf(person);
    if (brand && brand !== 'all') {
      if (!ids.includes(brand) || (me.role !== 'admin' && !crm.canBrand(user, brand)))
        throw fail(404, 'Marca o registro no disponible.');
      ids = [brand];
    }
    const coord = coordination(person, ids);
    return {
      person: { id: person.id, name: person.name, role: person.role, self: person.id === me.id },
      period: { days: p.days, from: p.from, to: p.to },
      scope: { brands: ids.map(id => ({ id, name: brandName(id) })) },
      sales: sales(person, ids, p),
      commissions: commissions(person, ids, p),
      pipeline: pipeline(person, ids, p),
      coordination: { editions: coord.editions },
      alerts: coord.alerts,
      people:
        me.role === 'admin'
          ? db
              .prepare("SELECT id,name,role FROM users WHERE role IN ('agent','admin') AND disabled=0 ORDER BY name")
              .all()
          : [],
      notes: [
        'Cifras del laboratorio: los pagos son simulados y no hay cobros reales.',
        'Las ventas y comisiones salen del libro de Finanzas; la cartera, de las oportunidades a tu nombre; las aperturas, de las que coordinas.',
      ],
    };
  }

  async function handle(req, res, path, user) {
    if (path !== '/api/portal/me' && path !== '/api/portal/team') return false;
    if (req.method !== 'GET') throw fail(405, 'Método no permitido.');
    const params = new URL(req.url, 'http://localhost').searchParams;
    json(res, 200, path === '/api/portal/team' ? team(user, params) : overview(user, params));
    return true;
  }
  return { handle, overview, team };
}
