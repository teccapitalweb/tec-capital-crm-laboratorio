import { cancelConversationSteps } from './automation.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { transaction } from './database.mjs';
import { defaultHours, validateHours, validateHolidays, isOpen, serviceDeadline } from './service-hours.mjs';
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, n = 500) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const closed = s => ['ganada', 'perdida'].includes(s);
const integer = (v, min, max, label) => {
  v = Number(v);
  if (!Number.isInteger(v) || v < min || v > max) throw fail(400, label + ' fuera de rango.');
  return v;
};
const check = (row, input) => {
  if (Number(input.expectedRevision) !== row.revision)
    throw fail(409, 'Los datos cambiaron. Recarga antes de continuar.');
};

export function createOperations({
  db,
  crm,
  catalogue,
  body,
  json,
  audit,
  broadcast,
  online,
  insertMessage,
  now = Date.now,
}) {
  const userBy = id => (typeof id === 'string' ? db.prepare('SELECT * FROM users WHERE id=?').get(id) : null);
  const admin = u => {
    const current = userBy(u.id);
    if (!current || current.disabled || current.role !== 'admin')
      throw fail(403, 'Sólo administración configura la operación.');
  };
  const scoped = (table, id, u) => {
    if (typeof id !== 'string') throw fail(404, 'Registro no disponible.');
    const r = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!r) throw fail(404, 'Registro no disponible.');
    crm.requireBrand(u, r.brand_id);
    return r;
  };
  function requireBrand(user, id) {
    if (typeof id !== 'string' || !db.prepare('SELECT 1 FROM brands WHERE id=?').get(id))
      throw fail(404, 'Marca no disponible.');
    crm.requireBrand(user, id);
  }
  function settings(brand) {
    const r = db.prepare('SELECT * FROM operation_settings WHERE brand_id=?').get(brand);
    return r
      ? {
          ...r,
          hours: JSON.parse(r.hours),
          member_ids: JSON.parse(r.member_ids),
          holidays: JSON.parse(r.holidays || '[]'),
        }
      : {
          brand_id: brand,
          routing_enabled: 0,
          sla_enabled: 0,
          timezone: 'America/Mexico_City',
          hours: defaultHours(),
          member_ids: [],
          holidays: [],
          first_minutes: 30,
          next_minutes: 60,
          revision: 0,
        };
  }
  function state(c) {
    db.prepare(
      "INSERT OR IGNORE INTO service_state(conversation_id,last_owner,first_human_at) VALUES(?,?,(SELECT MIN(created_at) FROM messages WHERE conversation_id=? AND sender_kind='agent'))",
    ).run(c.id, c.assigned_to, c.id);
    return db.prepare('SELECT * FROM service_state WHERE conversation_id=?').get(c.id);
  }
  function opportunity(c) {
    return db
      .prepare(
        'SELECT o.* FROM opportunities o JOIN conversation_opportunities co ON co.opportunity_id=o.id WHERE co.conversation_id=?',
      )
      .get(c.id);
  }
  function group(c) {
    const o = opportunity(c);
    return o
      ? db
          .prepare(
            "SELECT c.* FROM conversations c JOIN conversation_opportunities co ON co.conversation_id=c.id WHERE co.opportunity_id=? AND c.status!='resolved'",
          )
          .all(o.id)
      : [c];
  }
  function event(c, u, kind, details) {
    db.prepare(
      'INSERT INTO operation_events(brand_id,conversation_id,actor_id,kind,details,created_at) VALUES(?,?,?,?,?,?)',
    ).run(c.brand_id, c.id || null, u?.id || null, kind, JSON.stringify(details), now());
    audit(u, 'operation.' + kind, c.id || c.brand_id);
  }
  function notify(userId, c, kind, title, key) {
    const u = userBy(userId);
    if (!crm.canBrand(u, c.brand_id)) return;
    db.prepare(
      'INSERT OR IGNORE INTO notifications(id,user_id,brand_id,conversation_id,kind,title,event_key,created_at) VALUES(?,?,?,?,?,?,?,?)',
    ).run(randomUUID(), userId, c.brand_id, c.id || null, kind, title, key, now());
  }
  function change(c) {
    broadcast('crm', null, { brandId: c.brand_id });
    if (c.id) broadcast('conversation', c.id);
  }
  const allStaff = () =>
    db
      .prepare(
        "SELECT u.id,u.name,u.role,u.disabled,COALESCE(p.availability,'available') availability,COALESCE(l.max_open,8) max_open,COALESCE(l.revision,0) revision FROM users u LEFT JOIN preferences p ON p.user_id=u.id LEFT JOIN routing_limits l ON l.user_id=u.id WHERE u.role IN ('admin','agent')",
      )
      .all();
  const load = id =>
    db.prepare("SELECT count(*) n FROM conversations WHERE assigned_to=? AND status!='resolved'").get(id).n;
  const members = (brand, viewer) =>
    allStaff()
      .filter(u => crm.canBrand(u, brand))
      .map(u => ({
        ...u,
        online: online(u.id),
        load:
          viewer?.role === 'admin' || viewer?.id === u.id
            ? load(u.id)
            : db
                .prepare(
                  "SELECT count(*) n FROM conversations WHERE brand_id=? AND assigned_to=? AND status!='resolved'",
                )
                .get(brand, u.id).n,
      }));
  function editable(c, u) {
    if (c.status === 'resolved') throw fail(409, 'La conversación está cerrada.');
    if (c.assigned_to && c.assigned_to !== u.id && u.role !== 'admin') throw fail(409, 'Otro asesor está atendiendo.');
  }
  function capacity(c, target) {
    const limit = db.prepare('SELECT max_open FROM routing_limits WHERE user_id=?').get(target)?.max_open || 8,
      extra = group(c).filter(g => g.assigned_to !== target).length;
    return extra === 0 || load(target) + extra <= limit;
  }
  crm.setAssignmentGuard(idOwnerGuard);
  function idOwnerGuard(id, owner) {
    const c = db
      .prepare(
        "SELECT c.* FROM conversations c JOIN conversation_opportunities co ON co.conversation_id=c.id WHERE co.opportunity_id=? AND c.status!='resolved' LIMIT 1",
      )
      .get(id);
    if (c && !capacity(c, owner)) throw fail(409, 'El asesor alcanzó su límite de conversaciones abiertas.');
  }
  function cancelTransfers(c, reason, except = null) {
    for (const t of db
      .prepare("SELECT * FROM transfers WHERE conversation_id=? AND status='pending' AND id!=?")
      .all(c.id, except || '')) {
      db.prepare("UPDATE transfers SET status='cancelled',decided_at=? WHERE id=?").run(now(), t.id);
      event(c, null, 'transfer.cancelled', { transferId: t.id, reason });
      notify(t.to_id, c, 'transfer', 'Transferencia cancelada: ' + reason, 'transfer-cancel:' + t.id);
    }
  }
  function assign(c, target, u, reason, transferId = null) {
    if (target) {
      const person = userBy(target);
      if (!crm.canBrand(person, c.brand_id)) throw fail(400, 'El destinatario no tiene acceso a la marca.');
      if (!capacity(c, target)) throw fail(409, 'El asesor alcanzó su límite de conversaciones abiertas.');
    }
    const rows = group(c);
    for (const row of rows) {
      if (row.assigned_to && row.assigned_to !== c.assigned_to && row.assigned_to !== target && u?.role !== 'admin')
        throw fail(409, 'Otro chat de esta oportunidad tiene un responsable distinto. Pide revisión a administración.');
    }
    crm.assignConversation(c, target, u || null);
    for (const row of rows) {
      state(row);
      db.prepare('UPDATE conversations SET assigned_to=?,bot_enabled=0,status=?,updated_at=? WHERE id=?').run(
        target,
        target ? 'open' : 'waiting',
        now(),
        row.id,
      );
      db.prepare("UPDATE jobs SET state='cancelled' WHERE conversation_id=? AND state='pending'").run(row.id);
      cancelConversationSteps(db, row.id, 'human_takeover');
      db.prepare(
        'UPDATE service_state SET revision=revision+1,last_owner=?,queued_since=? WHERE conversation_id=?',
      ).run(target, target ? null : now(), row.id);
      cancelTransfers(row, reason, transferId);
      event(row, u, 'assignment', { from: row.assigned_to, to: target, reason });
      if (target)
        notify(
          target,
          row,
          'assignment',
          'Conversación asignada: ' + reason,
          'assign:' + row.id + ':' + state(row).revision,
        );
    }
  }
  function requestHuman(c, since = now()) {
    const s = state(c);
    if (s.waiting_since !== null) return;
    const p = settings(c.brand_id),
      due = p.sla_enabled ? serviceDeadline(since, s.first_human_at ? p.next_minutes : p.first_minutes, p) : null;
    db.prepare(
      'UPDATE service_state SET waiting_since=?,due_at=?,policy_revision=?,policy=?,queued_since=CASE WHEN ? IS NULL THEN ? ELSE queued_since END,revision=revision+1 WHERE conversation_id=?',
    ).run(since, due, p.revision, JSON.stringify(p), c.assigned_to, since, c.id);
    event(c, null, 'waiting', {
      since,
      dueAt: due,
      policyRevision: p.revision,
      kind: s.first_human_at ? 'next' : 'first',
    });
  }
  function message(c, kind, actor = null) {
    const current = db.prepare('SELECT * FROM conversations WHERE id=?').get(c.id),
      s = state(current);
    if (kind === 'customer' && !current.bot_enabled) requestHuman(current);
    if (kind === 'agent') {
      if (s.waiting_since !== null)
        event(current, actor, 'response', {
          waitingSince: s.waiting_since,
          respondedAt: now(),
          dueAt: s.due_at,
          withinTarget: s.due_at === null ? null : now() <= s.due_at,
          kind: s.first_human_at ? 'next' : 'first',
        });
      db.prepare(
        'UPDATE service_state SET waiting_since=NULL,due_at=NULL,queued_since=NULL,first_human_at=COALESCE(first_human_at,?),revision=revision+1 WHERE conversation_id=?',
      ).run(now(), c.id);
    }
  }
  function reset(c, kind, u) {
    state(c);
    db.prepare(
      'UPDATE service_state SET waiting_since=NULL,due_at=NULL,queued_since=NULL,revision=revision+1 WHERE conversation_id=?',
    ).run(c.id);
    cancelTransfers(c, kind);
    event(c, u, kind, {});
  }
  function sync(c) {
    const s = state(c),
      o = opportunity(c);
    if (c.status === 'resolved' || closed(o?.stage) || c.bot_enabled) {
      if (s.waiting_since !== null || s.queued_since !== null)
        reset(
          c,
          c.status === 'resolved' ? 'resolved' : closed(o?.stage) ? 'commercial.closed' : 'automation.resumed',
          null,
        );
      cancelTransfers(c, 'La atención cambió');
      return false;
    }
    if (s.last_owner !== c.assigned_to) {
      db.prepare('UPDATE service_state SET last_owner=?,revision=revision+1 WHERE conversation_id=?').run(
        c.assigned_to,
        c.id,
      );
      cancelTransfers(c, 'Cambió el responsable');
    }
    if (!c.assigned_to && s.queued_since === null)
      db.prepare('UPDATE service_state SET queued_since=? WHERE conversation_id=?').run(now(), c.id);
    if (s.waiting_since === null) {
      const waiting = db
        .prepare(
          "SELECT MIN(created_at) t FROM messages WHERE conversation_id=? AND sender_kind='customer' AND seq>COALESCE((SELECT MAX(seq) FROM messages WHERE conversation_id=? AND sender_kind='agent'),0)",
        )
        .get(c.id, c.id).t;
      if (waiting !== null) requestHuman(c, waiting);
    }
    return true;
  }
  function reconcile() {
    let changed = new Map();
    transaction(db, () => {
      for (const t of db.prepare("SELECT * FROM transfers WHERE status='pending'").all()) {
        const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(t.conversation_id);
        if (
          t.expires_at <= now() ||
          !crm.canBrand(userBy(t.to_id), t.brand_id) ||
          c.assigned_to !== t.from_id ||
          c.status === 'resolved' ||
          closed(opportunity(c)?.stage)
        ) {
          db.prepare('UPDATE transfers SET status=?,decided_at=? WHERE id=?').run(
            t.expires_at <= now() ? 'expired' : 'cancelled',
            now(),
            t.id,
          );
          event(c, null, 'transfer.ended', {
            transferId: t.id,
            reason: t.expires_at <= now() ? 'Venció sin aceptar' : 'Cambió el acceso o la atención',
          });
          notify(
            t.requested_by,
            c,
            'transfer',
            'La transferencia terminó sin cambio de responsable',
            'transfer-ended:' + t.id,
          );
          changed.set(c.id, c);
        }
      }
      const rows = db
        .prepare(
          "SELECT c.* FROM conversations c LEFT JOIN service_state s ON s.conversation_id=c.id WHERE c.status!='resolved' OR s.waiting_since IS NOT NULL ORDER BY CASE s.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,COALESCE(s.queued_since,c.created_at),c.id",
        )
        .all();
      for (const c of rows) {
        const before = state(c).revision;
        if (!sync(c)) {
          if (state(c).revision !== before) changed.set(c.id, c);
          continue;
        }
        const p = settings(c.brand_id),
          s = state(c);
        if (!c.assigned_to && p.routing_enabled && isOpen(now(), p)) {
          const available = members(c.brand_id)
            .filter(
              u =>
                p.member_ids.includes(u.id) &&
                u.availability === 'available' &&
                u.online &&
                capacity(c, u.id) &&
                group(c).every(g => !g.assigned_to || g.assigned_to === u.id),
            )
            .sort(
              (a, b) =>
                load(a.id) - load(b.id) ||
                db
                  .prepare(
                    "SELECT COALESCE(MAX(created_at),0) t FROM notifications WHERE user_id=? AND kind='assignment'",
                  )
                  .get(a.id).t -
                  db
                    .prepare(
                      "SELECT COALESCE(MAX(created_at),0) t FROM notifications WHERE user_id=? AND kind='assignment'",
                    )
                    .get(b.id).t ||
                a.id.localeCompare(b.id),
            );
          if (available.length) {
            assign(c, available[0].id, null, 'Reparto por menor carga');
            c.assigned_to = available[0].id;
            changed.set(c.id, c);
          }
        }
        if (s.waiting_since !== null && s.due_at !== null && s.due_at <= now()) {
          const recipients = new Set(
            [
              c.assigned_to,
              ...allStaff()
                .filter(u => u.role === 'admin' && !u.disabled)
                .map(u => u.id),
            ].filter(Boolean),
          );
          const beforeCount = db.prepare('SELECT count(*) n FROM notifications').get().n;
          for (const id of recipients)
            notify(id, c, 'sla', 'Objetivo de respuesta humana vencido', 'sla:' + c.id + ':' + s.waiting_since);
          if (db.prepare('SELECT count(*) n FROM notifications').get().n !== beforeCount) changed.set(c.id, c);
        }
        if (state(c).revision !== before) changed.set(c.id, c);
      }
    });
    for (const c of changed.values()) change(c);
  }
  function once(u, input, kind, target, fn) {
    const ref = text(input.clientRef, 100);
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(ref)) throw fail(400, 'Referencia de operación no válida.');
    const old = db.prepare('SELECT * FROM operation_requests WHERE actor_id=? AND client_ref=?').get(u.id, ref);
    if (old) {
      if (old.kind !== kind || old.target_id !== target) throw fail(409, 'Referencia ya utilizada.');
      return { ...JSON.parse(old.result), duplicate: true };
    }
    const result = fn();
    db.prepare('INSERT INTO operation_requests VALUES(?,?,?,?,?,?)').run(
      u.id,
      ref,
      kind,
      target,
      JSON.stringify(result),
      now(),
    );
    return result;
  }
  function queue(user, url) {
    const brand = url.searchParams.get('brand') || 'all',
      filter = url.searchParams.get('filter') || 'all',
      q = text(url.searchParams.get('q'), 100),
      offset = integer(url.searchParams.get('offset') || 0, 0, 100000, 'Página');
    const rows = db
      .prepare(
        `SELECT c.*,s.revision operation_revision,s.priority,s.waiting_since,s.first_human_at,s.due_at,s.queued_since,s.policy_revision,u.name customer_name,b.name brand_name,k.title course_title,a.name agent_name,o.stage,o.id opportunity_id FROM conversations c JOIN service_state s ON s.conversation_id=c.id JOIN users u ON u.id=c.customer_id JOIN brands b ON b.id=c.brand_id JOIN courses k ON k.id=c.course_id LEFT JOIN users a ON a.id=c.assigned_to LEFT JOIN conversation_opportunities co ON co.conversation_id=c.id LEFT JOIN opportunities o ON o.id=co.opportunity_id WHERE c.status!='resolved' AND c.bot_enabled=0 AND o.stage NOT IN ('ganada','perdida') ORDER BY CASE s.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,COALESCE(s.waiting_since,s.queued_since,c.created_at),c.id`,
      )
      .all()
      .filter(
        c =>
          crm.canBrand(user, c.brand_id) &&
          (brand === 'all' || brand === c.brand_id) &&
          (!q ||
            [c.customer_name, c.course_title, c.brand_name]
              .join(' ')
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase()
              .includes(
                q
                  .normalize('NFD')
                  .replace(/[\u0300-\u036f]/g, '')
                  .toLowerCase(),
              )),
      );
    const selected = rows.filter(
      c =>
        filter === 'all' ||
        (filter === 'unassigned' && !c.assigned_to) ||
        (filter === 'mine' && c.assigned_to === user.id) ||
        (filter === 'overdue' && c.due_at !== null && c.due_at <= now()),
    );
    const result = selected.slice(offset, offset + 50).map(c => ({
      ...c,
      inHours: isOpen(now(), settings(c.brand_id)),
      routingEnabled: Boolean(settings(c.brand_id).routing_enabled),
    }));
    return {
      conversations: result,
      total: selected.length,
      nextOffset: offset + 50 < selected.length ? offset + 50 : null,
      counts: {
        all: rows.length,
        unassigned: rows.filter(c => !c.assigned_to).length,
        mine: rows.filter(c => c.assigned_to === user.id).length,
        overdue: rows.filter(c => c.due_at !== null && c.due_at <= now()).length,
      },
    };
  }
  function macroPlan(c, m, u) {
    editable(c, u);
    if (!m.enabled || m.brand_id !== c.brand_id) throw fail(409, 'La macro no está activa para esta marca.');
    const o = opportunity(c);
    if (!o || closed(o.stage)) throw fail(409, 'Reabre la oportunidad antes de aplicar una macro.');
    const a = JSON.parse(m.actions),
      prepared = a.templateId ? catalogue.prepare(c, { templateId: a.templateId }) : null,
      order = ['nuevo', 'interesado', 'inscripcion'];
    if (a.stage && order.indexOf(a.stage) < order.indexOf(o.stage))
      throw fail(409, 'Esta macro haría retroceder la etapa comercial.');
    if (!capacity(c, u.id)) throw fail(409, 'Alcanzaste tu límite de conversaciones abiertas.');
    const token = hash({
      macro: m.id,
      revision: m.revision,
      conversation: c.id,
      owner: c.assigned_to,
      status: c.status,
      state: state(c).revision,
      opportunity: o.revision,
      prepared: prepared?.previewToken,
      actor: u.id,
    });
    return { macroId: m.id, title: m.title, actions: a, prepared, previewToken: token, opportunityId: o.id };
  }
  async function handle(req, res, path, user) {
    if (!path.startsWith('/api/operations')) return false;
    const current = userBy(user.id);
    if (!current || current.disabled || !['admin', 'agent'].includes(current.role))
      throw fail(403, 'Operación interna del equipo.');
    user = current;
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && path === '/api/operations/queue') {
      reconcile();
      json(res, 200, queue(user, url));
      return true;
    }
    if (req.method === 'GET' && path === '/api/operations/notifications') {
      const cursor = url.searchParams.get('before'),
        match = cursor?.match(/^(\d+):([a-f0-9-]+)$/);
      if (cursor && !match) throw fail(400, 'Página de avisos no válida.');
      const before = match ? Number(match[1]) : Number.MAX_SAFE_INTEGER,
        beforeId = match?.[2] || '',
        all = db
          .prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC,id DESC')
          .all(user.id)
          .filter(n => crm.canBrand(user, n.brand_id));
      const items = all.filter(n => n.created_at < before || (n.created_at === before && n.id < beforeId)).slice(0, 51);
      json(res, 200, {
        items: items.slice(0, 50),
        unread: all.filter(n => !n.read_at).length,
        nextBefore: items.length > 50 ? items[49].created_at + ':' + items[49].id : null,
      });
      return true;
    }
    if (req.method === 'POST' && path === '/api/operations/notifications/read') {
      const input = await body(req);
      for (const n of db.prepare('SELECT * FROM notifications WHERE user_id=? AND read_at IS NULL').all(user.id))
        if (crm.canBrand(user, n.brand_id) && (!input.id || input.id === n.id))
          db.prepare('UPDATE notifications SET read_at=? WHERE id=?').run(now(), n.id);
      json(res, 200, { ok: true });
      return true;
    }
    const configHistory = path.match(/^\/api\/operations\/brands\/([a-z0-9-]+)\/history$/);
    if (configHistory && req.method === 'GET') {
      requireBrand(user, configHistory[1]);
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER,
        events = db
          .prepare(
            "SELECT e.*,u.name actor_name FROM operation_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.brand_id=? AND e.kind='settings' AND e.seq<? ORDER BY e.seq DESC LIMIT 51",
          )
          .all(configHistory[1], before);
      json(res, 200, {
        events: events.slice(0, 50).map(e => ({ ...e, details: JSON.parse(e.details) })),
        nextBefore: events.length > 50 ? events[49].seq : null,
      });
      return true;
    }
    const config = path.match(/^\/api\/operations\/brands\/([a-z0-9-]+)$/);
    if (config) {
      requireBrand(user, config[1]);
      if (req.method === 'GET') {
        json(res, 200, { settings: settings(config[1]), members: members(config[1], user) });
        return true;
      }
      if (req.method === 'PATCH') {
        const input = await body(req);
        admin(user);
        const p = settings(config[1]);
        check(p, input);
        let hours;
        try {
          hours = validateHours(input.hours, text(input.timezone, 80));
        } catch (e) {
          throw fail(400, e.message);
        }
        if (hours.reduce((n, h) => n + (h ? h[1] - h[0] : 0), 0) < 60)
          throw fail(400, 'Configura al menos una hora de atención a la semana.');
        const ids = [...new Set(Array.isArray(input.memberIds) ? input.memberIds : [])];
        for (const id of ids)
          if (!crm.canBrand(userBy(id), config[1])) throw fail(400, 'Un asesor elegido no tiene acceso a la marca.');
        if (input.routingEnabled === true && !ids.length)
          throw fail(400, 'Elige al menos un asesor para activar el reparto.');
        let holidays;
        try {
          holidays = validateHolidays(input.holidays, now()) ?? p.holidays;
        } catch (e) {
          throw fail(400, e.message);
        }
        const first = integer(input.firstMinutes, 1, 480, 'Primera respuesta'),
          next = integer(input.nextMinutes, 1, 480, 'Siguiente respuesta');
        transaction(db, () => {
          db.prepare(
            'INSERT INTO operation_settings(brand_id,routing_enabled,sla_enabled,timezone,hours,member_ids,first_minutes,next_minutes,revision,updated_at,holidays) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(brand_id) DO UPDATE SET holidays=excluded.holidays,routing_enabled=excluded.routing_enabled,sla_enabled=excluded.sla_enabled,timezone=excluded.timezone,hours=excluded.hours,member_ids=excluded.member_ids,first_minutes=excluded.first_minutes,next_minutes=excluded.next_minutes,revision=excluded.revision,updated_at=excluded.updated_at',
          ).run(
            config[1],
            input.routingEnabled === true ? 1 : 0,
            input.slaEnabled === true ? 1 : 0,
            input.timezone,
            JSON.stringify(hours),
            JSON.stringify(ids),
            first,
            next,
            p.revision + 1,
            now(),
            JSON.stringify(holidays),
          );
          event({ brand_id: config[1] }, user, 'settings', { previous: p, next: settings(config[1]) });
        });
        change({ brand_id: config[1] });
        json(res, 200, { settings: settings(config[1]) });
        return true;
      }
    }
    const limit = path.match(/^\/api\/operations\/members\/([a-f0-9-]+)\/limit$/);
    if (limit && req.method === 'PATCH') {
      const input = await body(req);
      admin(user);
      const target = userBy(limit[1]);
      if (!target || target.disabled || !['admin', 'agent'].includes(target.role))
        throw fail(400, 'Selecciona un integrante activo.');
      const old = db.prepare('SELECT * FROM routing_limits WHERE user_id=?').get(target.id) || { revision: 0 };
      check(old, input);
      db.prepare(
        'INSERT INTO routing_limits VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET max_open=excluded.max_open,revision=excluded.revision',
      ).run(target.id, integer(input.maxOpen, 1, 100, 'Límite'), old.revision + 1);
      audit(user, 'operation.limit', target.id);
      broadcast('crm');
      json(res, 200, { ok: true });
      return true;
    }
    const route = path.match(
      /^\/api\/operations\/conversations\/([a-f0-9-]+)(?:\/(take|release|priority|notes|transfer|history|macro-preview|macro-run))?$/,
    );
    if (route) {
      let c = scoped('conversations', route[1], user);
      const action = route[2];
      if (req.method === 'GET' && action === 'history') {
        const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER,
          events = db
            .prepare(
              'SELECT e.*,u.name actor_name FROM operation_events e LEFT JOIN users u ON u.id=e.actor_id WHERE conversation_id=? AND seq<? ORDER BY seq DESC LIMIT 51',
            )
            .all(c.id, before);
        json(res, 200, {
          events: events.slice(0, 50).map(e => ({ ...e, details: JSON.parse(e.details) })),
          nextBefore: events.length > 50 ? events[49].seq : null,
        });
        return true;
      }
      if (req.method === 'GET' && !action) {
        const o = opportunity(c);
        json(res, 200, {
          conversation: c,
          state: state(c),
          opportunity: o,
          settings: settings(c.brand_id),
          members: members(c.brand_id, user),
          notes: db
            .prepare(
              'SELECT n.*,u.name author_name FROM internal_notes n JOIN users u ON u.id=n.author_id WHERE n.contact_id=? ORDER BY n.created_at DESC LIMIT 50',
            )
            .all(o.contact_id),
          transfers: db
            .prepare(
              'SELECT t.*,u.name to_name,f.name from_name FROM transfers t JOIN users u ON u.id=t.to_id LEFT JOIN users f ON f.id=t.from_id WHERE t.conversation_id=? ORDER BY t.created_at DESC LIMIT 20',
            )
            .all(c.id),
          macros: db
            .prepare('SELECT * FROM macros WHERE brand_id=? AND enabled=1 ORDER BY title')
            .all(c.brand_id)
            .map(m => ({ ...m, actions: JSON.parse(m.actions) })),
        });
        return true;
      }
      if (req.method === 'POST') {
        const input = await body(req);
        c = scoped('conversations', c.id, user);
        let result = transaction(db, () => {
          if (action === 'macro-preview') return macroPlan(c, scoped('macros', input.macroId, user), user);
          return once(user, input, action, c.id, () => {
            if (['take', 'release', 'priority', 'transfer'].includes(action)) {
              editable(c, user);
              check(state(c), input);
            }
            if (action === 'take') {
              assign(c, user.id, user, 'Toma manual');
              return { ok: true };
            }
            if (action === 'release') {
              const reason = text(input.reason, 500);
              if (!reason) throw fail(400, 'Explica por qué lo devuelves a la cola.');
              assign(c, null, user, reason);
              return { ok: true };
            }
            if (action === 'priority') {
              if (!['normal', 'high', 'urgent'].includes(input.priority)) throw fail(400, 'Prioridad no válida.');
              db.prepare('UPDATE service_state SET priority=?,revision=revision+1 WHERE conversation_id=?').run(
                input.priority,
                c.id,
              );
              event(c, user, 'priority', { priority: input.priority, reason: text(input.reason) });
              return { ok: true };
            }
            if (action === 'notes') {
              const value = text(input.text, 4000),
                ids = [...new Set(Array.isArray(input.mentions) ? input.mentions : [])];
              if (!value) throw fail(400, 'Escribe una nota interna.');
              for (const id of ids)
                if (!crm.canBrand(userBy(id), c.brand_id))
                  throw fail(400, 'Sólo puedes mencionar integrantes de esta marca.');
              const id = randomUUID(),
                o = opportunity(c);
              db.prepare('INSERT INTO internal_notes VALUES(?,?,?,?,?,?)').run(
                id,
                o.contact_id,
                c.brand_id,
                user.id,
                value,
                now(),
              );
              event(c, user, 'note', { noteId: id, mentions: ids });
              for (const target of ids)
                notify(target, c, 'mention', user.name + ' te mencionó en una nota interna', 'note:' + id);
              return { id };
            }
            if (action === 'transfer') {
              const target = userBy(input.toId),
                context = text(input.context, 2000);
              if (!target || target.id === c.assigned_to || !crm.canBrand(target, c.brand_id))
                throw fail(400, 'Elige otro integrante autorizado de esta marca.');
              if (context.length < 5) throw fail(400, 'Añade contexto y el siguiente paso para el destinatario.');
              if (db.prepare("SELECT id FROM transfers WHERE conversation_id=? AND status='pending'").get(c.id))
                throw fail(409, 'Ya hay una transferencia pendiente.');
              const id = randomUUID();
              db.prepare(
                'INSERT INTO transfers(id,conversation_id,brand_id,from_id,to_id,requested_by,context,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',
              ).run(id, c.id, c.brand_id, c.assigned_to, target.id, user.id, context, now(), now() + 86400000);
              db.prepare('UPDATE service_state SET revision=revision+1 WHERE conversation_id=?').run(c.id);
              event(c, user, 'transfer.requested', { transferId: id, to: target.name, context });
              notify(target.id, c, 'transfer', user.name + ' solicita transferirte una conversación', 'transfer:' + id);
              return { id };
            }
            if (action === 'macro-run') {
              const m = scoped('macros', input.macroId, user),
                plan = macroPlan(c, m, user);
              if (plan.previewToken !== input.previewToken)
                throw fail(409, 'La macro, oferta o conversación cambió. Previsualiza otra vez.');
              assign(c, user.id, user, 'Macro: ' + m.title);
              let messageId = null,
                taskId = null,
                noteId = null;
              if (plan.prepared)
                messageId = insertMessage(
                  c,
                  user,
                  plan.prepared.text,
                  'agent',
                  'macro:' + user.id + ':' + input.clientRef,
                  null,
                  plan.prepared.flyerSnapshot ? c.course_id : null,
                  plan.prepared,
                );
              const a = plan.actions;
              if (a.stage) crm.setStage(c, a.stage, user, {});
              if (a.taskTitle) {
                taskId = randomUUID();
                const due = now() + a.delayMinutes * 60000;
                db.prepare(
                  'INSERT INTO tasks(id,opportunity_id,brand_id,title,owner_id,due_at,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
                ).run(taskId, plan.opportunityId, c.brand_id, a.taskTitle, user.id, due, user.id, now(), now());
                db.prepare(
                  "INSERT INTO crm_events(opportunity_id,actor_id,kind,details,created_at) VALUES(?,?,'task.created',?,?)",
                ).run(
                  plan.opportunityId,
                  user.id,
                  JSON.stringify({
                    taskId,
                    next: { title: a.taskTitle, dueAt: due, ownerId: user.id, ownerName: user.name, status: 'open' },
                  }),
                  now(),
                );
              }
              if (a.note) {
                noteId = randomUUID();
                db.prepare('INSERT INTO internal_notes VALUES(?,?,?,?,?,?)').run(
                  noteId,
                  opportunity(c).contact_id,
                  c.brand_id,
                  user.id,
                  a.note,
                  now(),
                );
              }
              event(c, user, 'macro.applied', {
                macroId: m.id,
                revision: m.revision,
                title: m.title,
                actions: a,
                messageId,
                taskId,
                noteId,
              });
              return { messageId, taskId, noteId };
            }
            throw fail(404, 'Acción no disponible.');
          });
        });
        if (action !== 'macro-preview') change(c);
        json(res, 200, result);
        return true;
      }
    }
    const transfer = path.match(/^\/api\/operations\/transfers\/([a-f0-9-]+)\/(accept|decline|cancel)$/);
    if (transfer && req.method === 'POST') {
      const input = await body(req);
      const result = transaction(db, () => {
        const t = scoped('transfers', transfer[1], user),
          c = scoped('conversations', t.conversation_id, user);
        return once(user, input, 'transfer-' + transfer[2], t.id, () => {
          if (t.status !== 'pending' || t.expires_at <= now()) throw fail(409, 'La transferencia ya terminó o venció.');
          if (transfer[2] === 'cancel') {
            if (user.id !== t.requested_by && user.role !== 'admin')
              throw fail(403, 'Sólo quien la pidió o administración puede cancelarla.');
          } else if (user.id !== t.to_id) throw fail(403, 'Sólo el destinatario puede responder.');
          if (c.status === 'resolved' || closed(opportunity(c)?.stage) || c.assigned_to !== t.from_id)
            throw fail(409, 'La conversación cambió; recarga la ficha.');
          if (transfer[2] === 'accept') assign(c, user.id, user, 'Transferencia aceptada', t.id);
          const status = { accept: 'accepted', decline: 'declined', cancel: 'cancelled' }[transfer[2]];
          db.prepare('UPDATE transfers SET status=?,decided_at=? WHERE id=?').run(status, now(), t.id);
          db.prepare('UPDATE service_state SET revision=revision+1 WHERE conversation_id=?').run(c.id);
          event(c, user, 'transfer.' + status, { transferId: t.id, reason: text(input.reason), context: t.context });
          notify(
            t.requested_by,
            c,
            'transfer',
            'Transferencia ' + { accepted: 'aceptada', declined: 'rechazada', cancelled: 'cancelada' }[status],
            'transfer-result:' + t.id,
          );
          change(c);
          return { ok: true };
        });
      });
      json(res, 200, result);
      return true;
    }
    if (path === '/api/operations/macros' && req.method === 'GET') {
      json(res, 200, {
        macros: db
          .prepare('SELECT * FROM macros ORDER BY title')
          .all()
          .filter(m => crm.canBrand(user, m.brand_id))
          .map(m => ({ ...m, actions: JSON.parse(m.actions) })),
      });
      return true;
    }
    const macro = path.match(/^\/api\/operations\/macros(?:\/([a-f0-9-]+))?(?:\/(history))?$/);
    if (macro && macro[2] && req.method === 'GET') {
      scoped('macros', macro[1], user);
      json(res, 200, {
        versions: db
          .prepare(
            'SELECT v.*,u.name actor_name FROM macro_versions v LEFT JOIN users u ON u.id=v.actor_id WHERE macro_id=? ORDER BY revision DESC LIMIT 50',
          )
          .all(macro[1])
          .map(v => ({ ...v, snapshot: JSON.parse(v.snapshot) })),
      });
      return true;
    }
    if (macro && ['POST', 'PATCH'].includes(req.method)) {
      const input = await body(req);
      admin(user);
      const old = macro[1] ? scoped('macros', macro[1], user) : null;
      if (old) check(old, input);
      const brand = old?.brand_id || input.brandId;
      requireBrand(user, brand);
      const a = input.actions || {},
        title = text(input.title, 120),
        template = a.templateId ? scoped('content_templates', a.templateId, user) : null;
      if (
        !title ||
        (template && template.brand_id !== brand) ||
        (a.stage && !['nuevo', 'interesado', 'inscripcion'].includes(a.stage))
      )
        throw fail(400, 'Revisa el nombre, plantilla y etapa.');
      if (input.enabled === true && template && template.status !== 'approved')
        throw fail(400, 'Aprueba la plantilla antes de activar la macro.');
      const actions = {
        templateId: template?.id || null,
        stage: a.stage || null,
        taskTitle: text(a.taskTitle, 180),
        delayMinutes: a.taskTitle ? integer(a.delayMinutes, 1, 525600, 'Plazo de tarea') : null,
        note: text(a.note, 2000),
      };
      if (!actions.templateId && !actions.stage && !actions.taskTitle && !actions.note)
        throw fail(400, 'Configura al menos una acción.');
      const id = old?.id || randomUUID(),
        revision = (old?.revision || 0) + 1;
      transaction(db, () => {
        db.prepare(
          'INSERT INTO macros VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,actions=excluded.actions,enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at',
        ).run(
          id,
          brand,
          title,
          JSON.stringify(actions),
          input.enabled === true ? 1 : 0,
          revision,
          user.id,
          old?.created_at || now(),
          now(),
        );
        db.prepare('INSERT INTO macro_versions VALUES(?,?,?,?,?)').run(
          id,
          revision,
          JSON.stringify({ title, actions, enabled: input.enabled === true }),
          user.id,
          now(),
        );
        event({ brand_id: brand }, user, 'macro.saved', { macroId: id, revision, title });
      });
      change({ brand_id: brand });
      json(res, old ? 200 : 201, { id, revision });
      return true;
    }
    throw fail(404, 'Acción de operación no disponible.');
  }
  return { handle, message, requestHuman, reset, reconcile, settings, state, assign };
}
