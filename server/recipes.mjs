import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { cancelSteps } from './automation.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const OPEN_STAGES = ['nuevo', 'interesado', 'inscripcion'];
const closed = s => ['ganada', 'perdida'].includes(s);
const TRIGGERS = ['silence', 'task_overdue', 'waiting_human'];
const WEEK = 7 * 24 * 60 * 60 * 1000,
  DAY = 24 * 60 * 60 * 1000,
  MAX_RECIPE_MESSAGES_PER_DAY = 2;

function integer(v, min, max, label) {
  if (!Number.isInteger(v) || v < min || v > max) throw fail(400, label + ' no válido.');
  return v;
}

// Receta = disparador (`silence`, `task_overdue` o `waiting_human`) + condiciones + hasta tres acciones. Cada ejecución es un único paso atómico del motor 4A.
export function createRecipes({
  db,
  catalogue,
  automation,
  insertMessage,
  broadcast,
  body,
  json,
  audit,
  now = Date.now,
}) {
  const KIND = 'recipe.run';
  const get = id => (typeof id === 'string' ? db.prepare('SELECT * FROM automation_recipes WHERE id=?').get(id) : null);
  const view = r => r && { ...r, definition: JSON.parse(r.definition) };
  const conv = id => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  const opp = c =>
    db
      .prepare(
        'SELECT o.* FROM opportunities o JOIN conversation_opportunities co ON co.opportunity_id=o.id WHERE co.conversation_id=?',
      )
      .get(c.id);
  const lastMessage = c =>
    db
      .prepare('SELECT id,sender_kind,created_at FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 1')
      .get(c.id);
  const template = id => db.prepare('SELECT * FROM content_templates WHERE id=?').get(id);

  function normalize(input, brandId, { forPublish = false } = {}) {
    if (!input || typeof input !== 'object') throw fail(400, 'Definición no válida.');
    const t = input.trigger || {};
    if (!TRIGGERS.includes(t.type)) throw fail(400, 'Disparador no disponible.');
    const trigger = { type: t.type, minutes: integer(t.minutes, 5, 43200, 'Minutos del disparador') };
    const c = input.conditions || {},
      conditions = {};
    if (c.courseId) {
      const k = db.prepare('SELECT brand_id FROM courses WHERE id=?').get(c.courseId);
      if (!k || k.brand_id !== brandId) throw fail(400, 'Curso no válido para la marca.');
      conditions.courseId = c.courseId;
    }
    if (c.editionId) {
      const e = db.prepare('SELECT brand_id,course_id FROM editions WHERE id=?').get(c.editionId);
      if (!e || e.brand_id !== brandId || (conditions.courseId && e.course_id !== conditions.courseId))
        throw fail(400, 'Edición no válida para la marca.');
      conditions.editionId = c.editionId;
    }
    if (c.requireConsent !== undefined && trigger.type === 'silence') {
      if (typeof c.requireConsent !== 'boolean') throw fail(400, 'Consentimiento requerido no válido.');
      if (c.requireConsent) conditions.requireConsent = true;
    }
    if (c.stages !== undefined) {
      if (!Array.isArray(c.stages) || !c.stages.length || c.stages.some(s => !OPEN_STAGES.includes(s)))
        throw fail(400, 'Etapas no válidas.');
      conditions.stages = [...new Set(c.stages)];
    }
    if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 3)
      throw fail(400, 'Define de una a tres acciones.');
    const seen = new Set(),
      actions = input.actions.map(a => {
        if (!a || seen.has(a.type)) throw fail(400, 'Acción no válida o repetida.');
        seen.add(a.type);
        if (a.type === 'template') {
          if (trigger.type !== 'silence')
            throw fail(400, 'Este disparador es una escalada interna: no envía mensajes al cliente.');
          const tpl = template(a.templateId);
          if (!tpl || tpl.brand_id !== brandId) throw fail(400, 'Plantilla no válida para la marca.');
          if (forPublish && tpl.status !== 'approved')
            throw fail(400, 'Aprueba la plantilla antes de publicar la receta.');
          return { type: 'template', templateId: tpl.id };
        }
        if (a.type === 'task') {
          const title = text(a.title, 180);
          if (!title) throw fail(400, 'La tarea necesita título.');
          return { type: 'task', title, delayMinutes: integer(a.delayMinutes, 1, 525600, 'Plazo de tarea') };
        }
        if (a.type === 'notify') {
          const title = text(a.title, 120);
          if (!title) throw fail(400, 'El aviso necesita texto.');
          return { type: 'notify', title };
        }
        throw fail(400, 'Acción no disponible.');
      });
    return { trigger, conditions, actions };
  }

  // Evaluación compartida por simulación, programación y ejecución. No escribe nada.
  // El disparador `silence` mira el último mensaje; `task_overdue` y `waiting_human` son escaladas internas (sin mensajes al cliente).
  function evaluate(def, c, opts = {}) {
    const {
        recipeStatus = 'published',
        sourceMessageId = null,
        taskId = null,
        dueAt = null,
        waitingSince = null,
      } = opts,
      type = def.trigger.type;
    const checks = [],
      add = (check, ok, detail, reason) => checks.push({ check, ok, detail, reason });
    const o = opp(c),
      last = lastMessage(c);
    let foundTask = null;
    if (type === 'silence')
      add(
        'conversation_open',
        c.status === 'open',
        c.status === 'open' ? 'La conversación está abierta.' : 'La conversación no está abierta.',
        'conversation_closed',
      );
    else
      add(
        'conversation_open',
        c.status !== 'resolved',
        c.status !== 'resolved' ? 'La conversación no está cerrada.' : 'La conversación está cerrada.',
        'conversation_closed',
      );
    add(
      'opportunity_open',
      Boolean(o) && !closed(o.stage),
      o
        ? closed(o.stage)
          ? 'La oportunidad está cerrada.'
          : 'La oportunidad está abierta.'
        : 'No hay oportunidad vinculada.',
      'opportunity_closed',
    );
    const stageOk = !def.conditions.stages || (o && def.conditions.stages.includes(o.stage));
    add(
      'stage',
      Boolean(stageOk),
      stageOk ? 'La etapa coincide.' : 'La etapa no coincide con la receta.',
      'stage_changed',
    );
    const subject = type === 'silence' ? c : o || c,
      scopeOk =
        (!def.conditions.courseId || subject.course_id === def.conditions.courseId) &&
        (!def.conditions.editionId || subject.edition_id === def.conditions.editionId);
    add(
      'scope',
      scopeOk,
      scopeOk ? 'Curso y edición coinciden.' : 'El curso o la edición no coinciden.',
      'scope_changed',
    );
    if (type === 'silence') {
      const teamLast = last && last.sender_kind !== 'customer' && last.sender_kind !== 'system';
      add(
        'silence',
        Boolean(teamLast) && (!sourceMessageId || last.id === sourceMessageId),
        teamLast
          ? sourceMessageId && last.id !== sourceMessageId
            ? 'Hay un mensaje nuevo después del que originó la receta.'
            : 'El último mensaje es del equipo y el cliente no ha respondido.'
          : 'El cliente ya respondió o no hay mensajes del equipo.',
        last?.sender_kind === 'customer' ? 'customer_replied' : 'conversation_changed',
      );
    } else if (type === 'task_overdue') {
      const task = taskId
        ? db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)
        : o
          ? db.prepare("SELECT * FROM tasks WHERE opportunity_id=? AND status='open' ORDER BY due_at LIMIT 1").get(o.id)
          : null;
      add(
        'task_open',
        Boolean(task) && task.status === 'open',
        task
          ? task.status === 'open'
            ? 'La tarea sigue abierta.'
            : 'La tarea ya no está abierta.'
          : 'No hay una tarea abierta en esta oportunidad.',
        'task_closed',
      );
      const same = Boolean(task) && (dueAt === null || task.due_at === dueAt);
      add('task_due', same, same ? 'El plazo de la tarea no cambió.' : 'La tarea se reprogramó.', 'task_rescheduled');
      foundTask = task || null;
    } else {
      const s = db.prepare('SELECT waiting_since FROM service_state WHERE conversation_id=?').get(c.id),
        waiting = s?.waiting_since ?? null;
      const ok = waiting !== null && (waitingSince === null || waiting === waitingSince);
      add(
        'waiting_human',
        ok,
        ok ? 'El cliente sigue esperando a una persona del equipo.' : 'Ya lo atendió una persona o no está esperando.',
        'attended',
      );
    }
    add(
      'recipe_published',
      recipeStatus === 'published',
      recipeStatus === 'published' ? 'La receta está publicada.' : 'La receta no está publicada.',
      'recipe_paused',
    );
    const tpl = def.actions.find(a => a.type === 'template');
    if (tpl) {
      const human = Boolean(c.assigned_to) || !c.bot_enabled;
      add(
        'no_human_control',
        !human,
        human
          ? 'Una persona del equipo controla la conversación; la receta no enviará mensajes.'
          : 'Nadie del equipo controla la conversación.',
        'human_takeover',
      );
      const consent = o
        ? db.prepare('SELECT status FROM contact_consent WHERE contact_id=?').get(o.contact_id)?.status || 'unknown'
        : 'unknown';
      add(
        'consent',
        consent !== 'opted_out' && (!def.conditions.requireConsent || consent === 'opted_in'),
        consent === 'opted_out'
          ? 'El contacto pidió no recibir mensajes.'
          : def.conditions.requireConsent && consent !== 'opted_in'
            ? 'La receta exige consentimiento registrado y este contacto no lo tiene.'
            : def.conditions.requireConsent
              ? 'El contacto aceptó recibir mensajes.'
              : 'El contacto no pidió la baja.',
        consent === 'opted_out' ? 'contact_opted_out' : 'no_consent',
      );
      const sent = o
        ? db
            .prepare(
              "SELECT count(*) n FROM messages m WHERE m.client_ref LIKE 'recipe:%' AND m.created_at>? AND m.conversation_id IN (SELECT co.conversation_id FROM conversation_opportunities co JOIN opportunities x ON x.id=co.opportunity_id WHERE x.contact_id=?)",
            )
            .get(now() - DAY, o.contact_id).n
        : 0;
      add(
        'frequency',
        sent < MAX_RECIPE_MESSAGES_PER_DAY,
        sent < MAX_RECIPE_MESSAGES_PER_DAY
          ? 'No supera el máximo de ' + MAX_RECIPE_MESSAGES_PER_DAY + ' mensajes automáticos por contacto cada 24 h.'
          : 'Ya recibió ' + sent + ' mensajes automáticos en las últimas 24 h.',
        'frequency_limit',
      );
      let preview = null,
        why = '';
      try {
        preview = catalogue.prepare(c, { templateId: tpl.templateId });
      } catch (e) {
        why = e.message;
      }
      add(
        'material_available',
        Boolean(preview),
        preview ? 'La plantilla se puede enviar con la oferta vigente.' : why || 'La plantilla no está disponible.',
        'material_unavailable',
      );
    }
    const blocked = checks.find(x => !x.ok);
    return { ok: !blocked, reason: blocked?.reason || null, checks, task: foundTask };
  }

  function describeActions(def, c) {
    return def.actions.map(a => {
      if (a.type === 'template') {
        try {
          const p = catalogue.prepare(c, { templateId: a.templateId });
          return { type: 'template', text: p.text, flyer: Boolean(p.flyerSnapshot) };
        } catch (e) {
          return { type: 'template', unavailable: e.message };
        }
      }
      if (a.type === 'task') return { type: 'task', title: a.title, dueInMinutes: a.delayMinutes };
      return { type: 'notify', title: a.title };
    });
  }

  // Simulación: no inserta mensajes, tareas, avisos, pasos ni eventos.
  function simulate(recipe, definition, c) {
    const def = definition
        ? normalize(definition, recipe.brand_id)
        : typeof recipe.definition === 'string'
          ? JSON.parse(recipe.definition)
          : recipe.definition,
      type = def.trigger.type,
      ms = def.trigger.minutes * 60000;
    const ev = evaluate(def, c, { recipeStatus: 'published' });
    let runAt = null,
      sourceMessageId = null;
    if (type === 'silence') {
      const last = lastMessage(c);
      runAt = last && last.sender_kind !== 'customer' ? last.created_at + ms : null;
      sourceMessageId = last?.id || null;
    } else if (type === 'task_overdue') {
      runAt = ev.task ? ev.task.due_at + ms : null;
    } else {
      const s = db.prepare('SELECT waiting_since FROM service_state WHERE conversation_id=?').get(c.id);
      runAt = s?.waiting_since != null ? s.waiting_since + ms : null;
    }
    return {
      matches: ev.ok,
      reason: ev.reason,
      checks: ev.checks,
      runAt,
      sourceMessageId,
      trigger: type,
      actions: describeActions(def, c),
      recipeRevision: recipe.revision,
    };
  }

  const handler = {
    check(step) {
      const { recipeId, def, sourceMessageId, taskId, dueAt, waitingSince } = step.payload,
        c = conv(step.conversation_id);
      if (!c || c.brand_id !== step.brand_id) return { cancel: 'conversation_missing' };
      const r = get(recipeId),
        ev = evaluate(def, c, { recipeStatus: r?.status, sourceMessageId, taskId, dueAt, waitingSince });
      return ev.ok ? null : { cancel: ev.reason };
    },
    commit(step) {
      const { def } = step.payload,
        c = conv(step.conversation_id),
        o = opp(c),
        t = now(),
        result = {},
        escalation = def.trigger.type !== 'silence';
      for (const a of def.actions) {
        if (a.type === 'template') {
          const prepared = catalogue.prepare(c, { templateId: a.templateId });
          result.messageId = insertMessage(
            c,
            null,
            prepared.text,
            'automation',
            'recipe:' + step.id,
            null,
            prepared.flyerSnapshot ? c.course_id : null,
            prepared,
          );
        } else if (a.type === 'task') {
          const id = randomUUID(),
            due = t + a.delayMinutes * 60000,
            owner = o.owner_id || c.assigned_to || null;
          db.prepare(
            'INSERT INTO tasks(id,opportunity_id,brand_id,title,owner_id,due_at,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
          ).run(id, o.id, c.brand_id, a.title, owner, due, null, t, t);
          db.prepare(
            "INSERT INTO crm_events(opportunity_id,actor_id,kind,details,created_at) VALUES(?,NULL,'task.created',?,?)",
          ).run(
            o.id,
            JSON.stringify({
              taskId: id,
              source: 'recipe',
              recipeId: step.payload.recipeId,
              next: { title: a.title, dueAt: due, ownerId: owner, status: 'open' },
            }),
            t,
          );
          result.taskId = id;
        } else {
          const people = new Set([o.owner_id, c.assigned_to].filter(Boolean)),
            admins = db
              .prepare("SELECT id FROM users WHERE role='admin' AND disabled=0")
              .all()
              .map(u => u.id);
          const targets = [...(escalation || !people.size ? new Set([...people, ...admins]) : people)];
          for (const id of targets)
            db.prepare(
              'INSERT OR IGNORE INTO notifications(id,user_id,brand_id,conversation_id,kind,title,event_key,created_at) VALUES(?,?,?,?,?,?,?,?)',
            ).run(randomUUID(), id, c.brand_id, c.id, 'recipe', a.title, 'recipe:' + step.id, t);
          result.notified = targets.length;
        }
      }
      return result;
    },
  };
  automation.register(KIND, handler);

  // Candidatos de cada disparador. Las tareas creadas por recetas no vuelven a escalar (evita cadenas infinitas). Ninguno es retroactivo: sólo cuenta lo ocurrido tras la publicación y en la última semana.
  function candidates(r, def, since) {
    const ms = def.trigger.minutes * 60000,
      type = def.trigger.type;
    if (type === 'silence')
      return db
        .prepare(
          "SELECT c.id cid,m.id mid,m.created_at at FROM conversations c JOIN messages m ON m.seq=(SELECT MAX(seq) FROM messages WHERE conversation_id=c.id) WHERE c.brand_id=? AND c.status='open' AND m.sender_kind IN ('agent','automation') AND m.created_at>=? ORDER BY m.created_at LIMIT 200",
        )
        .all(r.brand_id, since)
        .map(x => ({ cid: x.cid, key: x.mid, at: x.at + ms, extra: { sourceMessageId: x.mid } }));
    if (type === 'task_overdue')
      return db
        .prepare(
          "SELECT t.id tid,t.due_at,(SELECT co.conversation_id FROM conversation_opportunities co JOIN conversations v ON v.id=co.conversation_id WHERE co.opportunity_id=t.opportunity_id ORDER BY v.updated_at DESC LIMIT 1) cid FROM tasks t JOIN opportunities o ON o.id=t.opportunity_id WHERE o.brand_id=? AND t.status='open' AND t.due_at+?>=? AND NOT EXISTS (SELECT 1 FROM crm_events e WHERE e.opportunity_id=t.opportunity_id AND e.kind='task.created' AND json_extract(e.details,'$.taskId')=t.id AND json_extract(e.details,'$.source')='recipe') ORDER BY t.due_at LIMIT 200",
        )
        .all(r.brand_id, ms, since)
        .filter(x => x.cid && x.due_at >= since - WEEK)
        .map(x => ({
          cid: x.cid,
          key: 'task:' + x.tid + ':' + x.due_at,
          at: x.due_at + ms,
          extra: { taskId: x.tid, dueAt: x.due_at },
        }));
    return db
      .prepare(
        "SELECT s.conversation_id cid,s.waiting_since w FROM service_state s JOIN conversations c ON c.id=s.conversation_id WHERE c.brand_id=? AND c.status!='resolved' AND s.waiting_since IS NOT NULL AND s.waiting_since>=? ORDER BY s.waiting_since LIMIT 200",
      )
      .all(r.brand_id, since)
      .map(x => ({ cid: x.cid, key: 'wait:' + x.cid + ':' + x.w, at: x.w + ms, extra: { waitingSince: x.w } }));
  }
  let lastScan = 0;
  function scan() {
    const t = now(),
      made = [];
    if (t - lastScan < 5000) return made;
    lastScan = t;
    for (const r of db.prepare("SELECT * FROM automation_recipes WHERE status='published'").all()) {
      if (!automation.enabledFor(r.brand_id)) continue;
      const def = JSON.parse(r.definition),
        since = Math.max(r.activated_at || 0, t - WEEK);
      for (const row of candidates(r, def, since)) {
        if (db.prepare('SELECT 1 FROM automation_runs WHERE recipe_id=? AND source_key=?').get(r.id, row.key)) continue;
        // Silencio: una vez completada, la receta no vuelve a disparar en esa conversación hasta que el cliente responda (evita que su propio mensaje la reactive).
        if (
          def.trigger.type === 'silence' &&
          db
            .prepare(
              "SELECT 1 FROM automation_runs ru JOIN automation_steps s ON s.id=ru.step_id JOIN messages sm ON sm.id=ru.source_key WHERE ru.recipe_id=? AND ru.conversation_id=? AND s.state='completed' AND sm.seq>COALESCE((SELECT MAX(seq) FROM messages WHERE conversation_id=? AND sender_kind='customer'),0)",
            )
            .get(r.id, row.cid, row.cid)
        )
          continue;
        const c = conv(row.cid),
          ev = evaluate(def, c, { ...row.extra });
        if (!ev.ok) continue;
        try {
          automation.enqueue({
            brandId: r.brand_id,
            conversationId: c.id,
            kind: KIND,
            payload: { recipeId: r.id, revision: r.revision, def, ...row.extra },
            dedupeKey: 'recipe:' + r.id + ':' + row.key,
            scheduledAt: row.at,
            onCreate: step => {
              db.prepare(
                'INSERT INTO automation_runs(id,recipe_id,recipe_revision,brand_id,conversation_id,source_key,step_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
              ).run(randomUUID(), r.id, r.revision, r.brand_id, c.id, row.key, step.id, t);
              made.push(step.id);
            },
          });
        } catch (e) {
          console.error('Recipe scan failed:', e.name, e.message);
        }
      }
    }
    return made;
  }

  function snapshot(id, actor) {
    const r = get(id);
    db.prepare(
      'INSERT INTO automation_recipe_versions(recipe_id,revision,snapshot,actor_id,created_at) VALUES(?,?,?,?,?)',
    ).run(
      id,
      r.revision,
      JSON.stringify({ title: r.title, status: r.status, definition: JSON.parse(r.definition) }),
      actor,
      now(),
    );
  }
  function stopPending(r, reason, actor) {
    const rows = db
      .prepare(
        "SELECT id,brand_id FROM automation_steps WHERE kind=? AND state IN ('pending','reserved') AND json_extract(payload,'$.recipeId')=?",
      )
      .all(KIND, r.id);
    return cancelSteps(db, rows, reason, actor, now());
  }
  const guard = (r, input) => {
    if (!r) throw fail(404, 'Receta no encontrada.');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== r.revision)
      throw fail(409, 'La receta cambió. Recárgala.');
  };

  function create(input, user) {
    const brandId = input.brandId;
    if (typeof brandId !== 'string' || !db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))
      throw fail(404, 'Marca no encontrada.');
    const title = text(input.title, 120);
    if (!title) throw fail(400, 'La receta necesita nombre.');
    const def = normalize(input.definition, brandId);
    return transaction(db, () => {
      const id = randomUUID(),
        t = now();
      db.prepare(
        'INSERT INTO automation_recipes(id,brand_id,title,definition,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      ).run(id, brandId, title, JSON.stringify(def), user.id, t, t);
      snapshot(id, user.id);
      return view(get(id));
    });
  }
  function update(id, input, user) {
    return transaction(db, () => {
      const r = get(id);
      guard(r, input);
      const title = input.title === undefined ? r.title : text(input.title, 120);
      if (!title) throw fail(400, 'La receta necesita nombre.');
      const def = input.definition === undefined ? JSON.parse(r.definition) : normalize(input.definition, r.brand_id);
      stopPending(r, 'recipe_edited', user.id);
      db.prepare(
        "UPDATE automation_recipes SET title=?,definition=?,status='draft',revision=revision+1,updated_at=? WHERE id=?",
      ).run(title, JSON.stringify(def), now(), id);
      snapshot(id, user.id);
      return view(get(id));
    });
  }
  function publish(id, input, user) {
    return transaction(db, () => {
      const r = get(id);
      guard(r, input);
      if (r.status === 'published') throw fail(409, 'La receta ya está publicada.');
      normalize(JSON.parse(r.definition), r.brand_id, { forPublish: true });
      db.prepare(
        "UPDATE automation_recipes SET status='published',activated_at=?,revision=revision+1,updated_at=? WHERE id=?",
      ).run(now(), now(), id);
      snapshot(id, user.id);
      return view(get(id));
    });
  }
  function pause(id, input, user) {
    return transaction(db, () => {
      const r = get(id);
      guard(r, input);
      if (r.status !== 'published') throw fail(409, 'Sólo se puede pausar una receta publicada.');
      stopPending(r, 'recipe_paused', user.id);
      db.prepare("UPDATE automation_recipes SET status='paused',revision=revision+1,updated_at=? WHERE id=?").run(
        now(),
        id,
      );
      snapshot(id, user.id);
      return view(get(id));
    });
  }

  async function handle(req, res, path, user) {
    if (!path.startsWith('/api/automation/recipes')) return false;
    if (user.role !== 'admin') throw fail(403, 'La automatización la administra un administrador.');
    const url = new URL(req.url, 'http://localhost');
    let x;
    if (path === '/api/automation/recipes') {
      if (req.method === 'GET') {
        const brand = url.searchParams.get('brand');
        json(res, 200, {
          recipes: db
            .prepare(
              'SELECT * FROM automation_recipes' +
                (brand ? ' WHERE brand_id=?' : '') +
                ' ORDER BY updated_at DESC LIMIT 100',
            )
            .all(...(brand ? [brand] : []))
            .map(view),
        });
        return true;
      }
      if (req.method === 'POST') {
        const r = create(await body(req), user);
        audit(user, 'automation.recipe.create', r.id);
        json(res, 201, { recipe: r });
        return true;
      }
    }
    if (!(x = path.match(/^\/api\/automation\/recipes\/([a-f0-9-]{36})(?:\/(publish|pause|simulate|history|runs))?$/)))
      throw fail(404, 'Ruta de recetas no encontrada.');
    const r = get(x[1]);
    if (!r) throw fail(404, 'Receta no encontrada.');
    if (!x[2] && req.method === 'GET') {
      json(res, 200, { recipe: view(r) });
      return true;
    }
    if (!x[2] && req.method === 'PATCH') {
      const out = update(r.id, await body(req), user);
      audit(user, 'automation.recipe.update', r.id);
      json(res, 200, { recipe: out });
      return true;
    }
    if (x[2] === 'publish' && req.method === 'POST') {
      const out = publish(r.id, await body(req), user);
      audit(user, 'automation.recipe.publish', r.id);
      json(res, 200, { recipe: out });
      return true;
    }
    if (x[2] === 'pause' && req.method === 'POST') {
      const out = pause(r.id, await body(req), user);
      audit(user, 'automation.recipe.pause', r.id);
      json(res, 200, { recipe: out });
      return true;
    }
    if (x[2] === 'history' && req.method === 'GET') {
      json(res, 200, {
        versions: db
          .prepare(
            'SELECT revision,snapshot,actor_id,created_at FROM automation_recipe_versions WHERE recipe_id=? ORDER BY revision',
          )
          .all(r.id)
          .map(v => ({ ...v, snapshot: JSON.parse(v.snapshot) })),
      });
      return true;
    }
    if (x[2] === 'runs' && req.method === 'GET') {
      json(res, 200, {
        runs: db
          .prepare(
            'SELECT ru.id,ru.recipe_revision,ru.conversation_id,ru.created_at,s.id step_id,s.state,s.scheduled_at,s.attempts,s.cancel_reason,s.error,s.result FROM automation_runs ru JOIN automation_steps s ON s.id=ru.step_id WHERE ru.recipe_id=? ORDER BY ru.created_at DESC LIMIT 100',
          )
          .all(r.id),
      });
      return true;
    }
    if (x[2] === 'simulate' && req.method === 'POST') {
      const input = await body(req),
        c = conv(input.conversationId);
      if (!c || c.brand_id !== r.brand_id) throw fail(404, 'Conversación no disponible para esta marca.');
      json(res, 200, { simulation: simulate(r, input.definition, c) });
      return true;
    }
    throw fail(405, 'Método no permitido.');
  }

  return { create, update, publish, pause, simulate, scan, handle, evaluate, get: id => view(get(id)) };
}
