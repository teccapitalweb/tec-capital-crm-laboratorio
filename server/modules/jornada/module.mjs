// Jornada simulada (docs/PLAN_JORNADA_SIMULADA.md): un día de trabajo con clientes de mentira que llegan a goteo durante
// horas, el asistente y el equipo los atienden como siempre, y aquí se supervisa en vivo: cuántos llegaron, cuántos
// atendió el asistente solo, cuántos esperan, cómo va la persona que atiende y qué falló (alertas). Construida sobre
// el simulador de clientes (server/simulator.mjs): cada llegada es un cliente «· demo» que escribe por la misma API
// que un cliente real; la jornada sólo decide CUÁNDO entra cada uno y vigila.
//
// Rutas (sólo administración):
//   GET  /api/jornada?brand=                      jornadas de la marca y opciones (perfiles, ritmos, equipo, límites)
//   POST /api/jornada                             crea y arranca (o deja planeada si `startAt` es futuro)
//   GET  /api/jornada/:id                         la jornada en vivo: configuración, bloques, cifras, conversaciones,
//                                                 persona que atiende, alertas
//   GET  /api/jornada/:id/conversations/:cid      el chat de una conversación de la jornada (texto plano)
//   POST /api/jornada/:id/pause|resume|finish|archive
//   POST /api/jornada/:id/alerts/:aid/resolve
//   GET  /api/jornada/:id/report                  el informe (fallos agrupados, perfiles, cifras)
//   POST /api/jornada/:id/report/knowledge        {question} → un borrador de conocimiento (sin aprobar)
//   POST /api/jornada/:id/report/evaluation       {cases:[{inputText, expectAction, title}]} → casos del banco
// Reloj: cada 5 s arranca las planeadas, suma las llegadas que tocan, asigna a la persona lo que espera, detecta
// alertas y cierra la jornada cuando termina su tiempo y ya nadie está hablando. Aviso en vivo «jornada.changed».
import { randomUUID } from 'node:crypto';
import { PERSONAS, PACES } from '../../simulator-personas.mjs';
import { costCents, customerLine } from './ai.mjs';
import { buildReport } from './report.mjs';
import { ALERT_KINDS, DEFAULT_ALERTS, LIMITS, RHYTHMS, blocks, detectAlerts, median, planArrivals } from './plan.mjs';

const UUID = '[0-9a-f-]{36}';
const STATES = {
  planned: 'Programada',
  running: 'En curso',
  paused: 'En pausa',
  finished: 'Terminada',
  archived: 'Archivada',
};
const GRACE_MS = 10 * 60_000; // tras la hora de fin, se espera a que terminen los chats vivos hasta este margen
const NO_SUPO = /no la tengo a la mano/i;
const HANDOFF = /(te paso|pasarte|te comunico|te conecto|te canalizo) con (una persona|alguien|un asesor|el equipo)/i;

export default {
  name: 'jornada',
  timers: [{ name: 'reloj', everyMs: 5000, testEveryMs: 300, run: api => api.tick() }],
  create(host) {
    const { db, fail, json, body, audit } = host;
    const crm = host.services.crm;
    const sim = () => host.services.simulator;
    const now = () => Date.now();
    const one = (sql, ...a) => db.prepare(sql).get(...a) ?? null;
    const all = (sql, ...a) => db.prepare(sql).all(...a);
    const emit = (run, extra = {}) => {
      try {
        host.realtime?.emit('jornada.changed', { brandId: run.brand_id, data: { runId: run.id, ...extra } });
      } catch (e) {
        console.error('jornada: no se pudo avisar en vivo', e?.message);
      }
    };
    const getRun = id => one('SELECT * FROM jornada_runs WHERE id=?', id);
    const arrivalsOf = runId => all('SELECT * FROM jornada_arrivals WHERE run_id=? ORDER BY planned_at', runId);
    const parse = (raw, fallback) => {
      try {
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    };
    const int = (v, d) => (Number.isInteger(Number(v)) ? Number(v) : d);
    const userName = id => (id ? (one('SELECT name FROM users WHERE id=?', id)?.name ?? null) : null);

    // ---- crear
    function create(input, user) {
      const brandId = String(input.brandId || '');
      if (!brandId || !one('SELECT 1 FROM brands WHERE id=?', brandId)) throw fail(404, 'Marca no encontrada.');
      if (!crm.canBrand(user, brandId)) throw fail(404, 'Marca no disponible.', { code: 'not_found' });
      if (!sim()) throw fail(503, 'El simulador de clientes está apagado en este servidor.');
      const count = int(input.count, 0);
      if (count < 1 || count > LIMITS.maxCount) throw fail(400, `Indica de 1 a ${LIMITS.maxCount} clientes.`);
      const minutes = int(input.minutes, 0);
      if (minutes < LIMITS.minMinutes || minutes > LIMITS.maxMinutes)
        throw fail(400, `La jornada dura de ${LIMITS.minMinutes} minuto a ${LIMITS.maxMinutes / 60} horas.`);
      const rhythm = RHYTHMS[input.rhythm] ? input.rhythm : 'goteo';
      const pace = PACES[input.pace] ? input.pace : 'lenta';
      const personas =
        Array.isArray(input.personas) && input.personas.length ? [...new Set(input.personas)] : Object.keys(PERSONAS);
      if (personas.some(p => !PERSONAS[p])) throw fail(400, 'Perfil de cliente no válido.');
      let assigneeId = null;
      if (input.assigneeId) {
        const a = one("SELECT id,role,disabled FROM users WHERE id=? AND role IN ('admin','agent')", input.assigneeId);
        if (!a || a.disabled || !crm.canBrand(a, brandId))
          throw fail(400, 'La persona que atiende debe ser del equipo y tener acceso a la marca.');
        assigneeId = a.id;
      }
      const ai = input.ai === 'claude' ? 'claude' : 'guiones';
      if (ai === 'claude' && !aiAvailable())
        throw fail(409, 'La IA de Claude no está activa en este servidor: los clientes hablarán con guiones.');
      const capUsd = Number(input.aiCapUsd);
      const aiCapCents = Number.isFinite(capUsd) && capUsd >= 0.5 && capUsd <= 100 ? Math.round(capUsd * 100) : 300;
      const alerts = { ...DEFAULT_ALERTS };
      if (input.alerts && typeof input.alerts === 'object') {
        for (const k of Object.keys(ALERT_KINDS)) if (typeof input.alerts[k] === 'boolean') alerts[k] = input.alerts[k];
        const w = Number(input.alerts.waitMinutes);
        if (Number.isFinite(w) && w >= 1 && w <= 120) alerts.waitMinutes = Math.round(w);
      }
      if (one("SELECT 1 FROM jornada_runs WHERE brand_id=? AND state IN ('planned','running','paused')", brandId))
        throw fail(409, 'Esa marca ya tiene una jornada en curso. Termínala antes de empezar otra.');
      const t = now(),
        startAt =
          Number.isFinite(Number(input.startAt)) && Number(input.startAt) > t + 30_000 ? Number(input.startAt) : t,
        id = randomUUID(),
        title =
          typeof input.title === 'string' && input.title.trim()
            ? input.title.trim().slice(0, 80)
            : 'Jornada ' +
              new Intl.DateTimeFormat('es-MX', {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: 'America/Mexico_City',
              }).format(startAt);
      const plan = planArrivals({ count, startAt, minutes, rhythm, personas });
      host.transaction(db, () => {
        db.prepare(
          `INSERT INTO jornada_runs(id,brand_id,title,count,minutes,rhythm,pace,personas,assignee_id,alerts,state,starts_at,ends_at,created_by,created_at,updated_at,ai,ai_cap_cents)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          brandId,
          title,
          count,
          minutes,
          rhythm,
          pace,
          JSON.stringify(personas),
          assigneeId,
          JSON.stringify(alerts),
          startAt > t ? 'planned' : 'running',
          startAt,
          startAt + minutes * 60_000,
          user.id,
          t,
          t,
          ai,
          aiCapCents,
        );
        const ins = db.prepare('INSERT INTO jornada_arrivals(id,run_id,planned_at,persona,channel) VALUES(?,?,?,?,?)');
        for (const a of plan) ins.run(randomUUID(), id, a.plannedAt, a.persona, a.channel);
      });
      audit(user, 'jornada.create', id);
      const run = getRun(id);
      if (run.state === 'running') startRun(run, user);
      emit(run);
      return view(getRun(id), user);
    }
    function startRun(run, user) {
      const simId = sim().createRun(
        { title: run.title, brandIds: [run.brand_id], personas: parse(run.personas, []), pace: run.pace },
        user ?? { id: run.created_by },
      );
      db.prepare("UPDATE jornada_runs SET simulator_run_id=?,state='running',updated_at=? WHERE id=?").run(
        simId,
        now(),
        run.id,
      );
    }

    // ---- Claude actúa cada cliente
    const provider = () => host.services.aiProvider;
    const aiAvailable = () => Boolean(provider()?.name === 'claude' && provider()?.configured);
    const aiCost = run => costCents(provider()?.model, run.ai_input_tokens || 0, run.ai_output_tokens || 0);
    const aiOn = run => run.ai === 'claude' && aiAvailable() && aiCost(run) < run.ai_cap_cents;
    // Lo que el simulador llama antes de que un cliente escriba: si su jornada usa a Claude y hay tope, Claude pone las
    // palabras; si no, va el guion. Nunca lanza: cualquier fallo vuelve al guion y se anota.
    async function lineProvider(actor, { gist, human }) {
      const run = one(
        "SELECT * FROM jornada_runs WHERE simulator_run_id=? AND state IN ('running','paused')",
        actor.run_id,
      );
      if (!run || !aiOn(run)) return null;
      const persona = PERSONAS[actor.persona] || { label: actor.persona, description: '' };
      const transcript = actor.conversation_id
        ? all(
            'SELECT sender_kind kind,text FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 8',
            actor.conversation_id,
          ).reverse()
        : [];
      const course = actor.course_id ? one('SELECT title FROM courses WHERE id=?', actor.course_id) : null;
      const brand = one('SELECT name FROM brands WHERE id=?', run.brand_id);
      const out = await customerLine(provider(), {
        persona,
        gist: String(gist || '')
          .replaceAll('{{curso}}', course?.title || 'el curso')
          .replaceAll('{{nombre}}', String(actor.name || '').split(' ')[0]),
        transcript,
        brandName: brand?.name || run.brand_id,
        courseTitle: course?.title || '',
        human: Boolean(human),
      });
      const inTok = Number(out.usage?.input_tokens) || 0,
        outTok = Number(out.usage?.output_tokens) || 0;
      if (inTok || outTok || out.text)
        db.prepare(
          'UPDATE jornada_runs SET ai_calls=ai_calls+1,ai_input_tokens=ai_input_tokens+?,ai_output_tokens=ai_output_tokens+?,updated_at=? WHERE id=?',
        ).run(inTok, outTok, now(), run.id);
      if (!out.text && out.reason)
        db.prepare('UPDATE jornada_runs SET ai_note=? WHERE id=?').run(String(out.reason).slice(0, 200), run.id);
      const after = getRun(run.id);
      if (after && after.ai === 'claude' && aiCost(after) >= after.ai_cap_cents && !/tope/.test(after.ai_note))
        db.prepare('UPDATE jornada_runs SET ai_note=? WHERE id=?').run(
          'Se alcanzó el tope de gasto: los clientes siguen con guiones.',
          run.id,
        );
      return out.text;
    }
    let hooked = false;
    const hook = () => {
      if (hooked || !sim()) return;
      sim().useLineProvider(lineProvider);
      hooked = true;
    };

    // ---- lo que la jornada lee de cada conversación (para la lista, las cifras y las alertas)
    function conversationRows(run) {
      const rows = all(
        `SELECT ar.id arrival_id,ar.persona,ar.channel,ar.arrived_at,a.id actor_id,a.state actor_state,a.outcome,
                u.name,c.id conversation_id,c.status,c.assigned_to,c.last_customer_at,c.last_outbound_at,c.course_id,
                k.title course_title
         FROM jornada_arrivals ar
           JOIN simulator_actors a ON a.id=ar.actor_id
           JOIN users u ON u.id=a.user_id
           LEFT JOIN conversations c ON c.id=a.conversation_id
           LEFT JOIN courses k ON k.id=c.course_id
         WHERE ar.run_id=? AND ar.state='arrived' ORDER BY ar.arrived_at DESC`,
        run.id,
      );
      const last = db.prepare(
        'SELECT sender_kind,text,created_at FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 1',
      );
      const lastOf = db.prepare(
        'SELECT text,created_at FROM messages WHERE conversation_id=? AND sender_kind=? ORDER BY seq DESC LIMIT 1',
      );
      const prevCustomer = db.prepare(
        "SELECT text FROM messages WHERE conversation_id=? AND sender_kind='customer' AND seq<(SELECT COALESCE(MAX(seq),0) FROM messages WHERE conversation_id=? AND sender_kind='automation') ORDER BY seq DESC LIMIT 1",
      );
      const agentCount = db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND sender_kind='agent'");
      return rows.map(r => {
        if (!r.conversation_id)
          return {
            ...r,
            last: null,
            lastCustomerText: '',
            previousCustomerText: '',
            lastAutomationText: '',
            agentMessages: 0,
          };
        const l = last.get(r.conversation_id),
          lc = lastOf.get(r.conversation_id, 'customer'),
          la = lastOf.get(r.conversation_id, 'automation'),
          lg = lastOf.get(r.conversation_id, 'agent');
        return {
          ...r,
          last: l ? { kind: l.sender_kind, text: String(l.text || '').slice(0, 160), at: l.created_at } : null,
          lastCustomerText: lc?.text || '',
          lastCustomerAt: r.last_customer_at ?? lc?.created_at ?? null,
          lastOutboundAt: r.last_outbound_at ?? (Math.max(la?.created_at || 0, lg?.created_at || 0) || null),
          previousCustomerText: prevCustomer.get(r.conversation_id, r.conversation_id)?.text || '',
          lastAutomationText: la?.text || '',
          lastAutomationAt: la?.created_at ?? null,
          lastAgentAt: lg?.created_at ?? null,
          agentMessages: agentCount.get(r.conversation_id).n,
        };
      });
    }

    // ---- reloj
    function tick() {
      hook();
      const t = now();
      for (const run of all("SELECT * FROM jornada_runs WHERE state='planned' AND starts_at<=?", t)) {
        try {
          startRun(run, null);
          emit(run);
        } catch (e) {
          console.error('jornada: no se pudo arrancar', run.id, e?.message);
        }
      }
      for (const run of all("SELECT * FROM jornada_runs WHERE state='running'")) {
        try {
          tickRun(run, t);
        } catch (e) {
          console.error('jornada: fallo en el reloj', run.id, e?.message);
        }
      }
    }
    // Huella de lo que se ve de cada jornada: si cambia entre dos vueltas del reloj, se avisa en vivo (un chat nuevo,
    // un mensaje nuevo, un cambio de estado o de responsable), aunque la jornada no haya hecho nada.
    const huellas = new Map();
    const huella = rows =>
      rows
        .map(
          r =>
            `${r.conversation_id || '-'}:${r.status || ''}:${r.assigned_to || ''}:${r.last?.at || 0}:${r.actor_state}`,
        )
        .join('|');
    function tickRun(run, t) {
      let changed = false;
      // 1) llegadas que tocan
      for (const ar of all(
        "SELECT * FROM jornada_arrivals WHERE run_id=? AND state='planned' AND planned_at<=? ORDER BY planned_at LIMIT 5",
        run.id,
        t,
      )) {
        try {
          const made = sim().enroll(
            run.simulator_run_id,
            { persona: ar.persona, brandId: run.brand_id, channel: ar.channel },
            { id: run.created_by },
          );
          db.prepare("UPDATE jornada_arrivals SET state='arrived',actor_id=?,user_id=?,arrived_at=? WHERE id=?").run(
            made.actorId,
            made.userId,
            t,
            ar.id,
          );
          changed = true;
        } catch (e) {
          console.error('jornada: no llegó un cliente', e?.message);
          db.prepare("UPDATE jornada_arrivals SET state='skipped' WHERE id=?").run(ar.id);
        }
      }
      const rows = conversationRows(run);
      // 2) lo que espera a una persona va con la persona elegida (como si tomara el chat)
      if (run.assignee_id) {
        const person = one('SELECT * FROM users WHERE id=?', run.assignee_id);
        for (const r of rows) {
          if (!r.conversation_id || r.status !== 'waiting' || r.assigned_to) continue;
          const c = one('SELECT * FROM conversations WHERE id=?', r.conversation_id);
          if (!c || !person) continue;
          try {
            host.services.operations.assign(c, person.id, person, 'Jornada simulada');
            host.broadcast('conversation', c.id);
            changed = true;
          } catch (e) {
            console.error('jornada: no se pudo asignar', e?.message);
          }
        }
      }
      // 3) alertas: nuevas y resueltas solas
      const cfg = parse(run.alerts, {}),
        assigneeName = userName(run.assignee_id);
      const insert = db.prepare(
        'INSERT OR IGNORE INTO jornada_alerts(id,run_id,brand_id,kind,conversation_id,text,detail,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      );
      for (const r of rows.filter(x => x.conversation_id)) {
        const found = detectAlerts(
          {
            conversationId: r.conversation_id,
            name: r.name,
            status: r.status,
            assignedTo: r.assigned_to,
            assigneeName: r.assigned_to ? userName(r.assigned_to) || assigneeName : null,
            lastCustomerAt: r.lastCustomerAt,
            lastOutboundAt: r.lastOutboundAt,
            lastCustomerText: r.lastCustomerText,
            previousCustomerText: r.previousCustomerText,
            lastAutomationText: r.lastAutomationText,
          },
          cfg,
          t,
        );
        for (const a of found)
          if (
            insert.run(randomUUID(), run.id, run.brand_id, a.kind, r.conversation_id, a.text, a.detail, 'active', t)
              .changes
          )
            changed = true;
        // una espera que ya se atendió deja de ser alerta
        const answered =
          !r.lastCustomerAt || (r.lastOutboundAt && r.lastOutboundAt >= r.lastCustomerAt) || r.status === 'resolved';
        if (answered) {
          const n = db
            .prepare(
              "UPDATE jornada_alerts SET state='resolved',resolved_at=? WHERE run_id=? AND conversation_id=? AND state='active' AND kind IN ('sin_respuesta','persona_tarda')",
            )
            .run(t, run.id, r.conversation_id).changes;
          if (n) changed = true;
        }
      }
      // 4) termina cuando pasó su tiempo (más un margen) y ya nadie está hablando, o cuando se agotó el margen
      const pending = one("SELECT count(*) n FROM jornada_arrivals WHERE run_id=? AND state='planned'", run.id).n;
      const talking = run.simulator_run_id
        ? one(
            "SELECT count(*) n FROM simulator_actors WHERE run_id=? AND state IN ('active','waiting')",
            run.simulator_run_id,
          ).n
        : 0;
      if (t >= run.ends_at && !pending && (!talking || t >= run.ends_at + GRACE_MS)) {
        db.prepare("UPDATE jornada_runs SET state='finished',finished_at=?,updated_at=? WHERE id=?").run(t, t, run.id);
        if (run.simulator_run_id) {
          const s = sim().getRun(run.simulator_run_id);
          if (s && s.state === 'running') sim().stop(s, { id: run.created_by });
        }
        changed = true;
      }
      const h = huella(rows);
      if (huellas.get(run.id) !== h) {
        huellas.set(run.id, h);
        changed = true;
      }
      if (changed) emit(run);
    }

    // ---- vistas
    function summary(run) {
      const arr = arrivalsOf(run.id);
      return {
        id: run.id,
        brandId: run.brand_id,
        title: run.title,
        state: run.state,
        stateLabel: STATES[run.state] || run.state,
        count: run.count,
        minutes: run.minutes,
        rhythm: run.rhythm,
        rhythmLabel: RHYTHMS[run.rhythm]?.label || run.rhythm,
        startsAt: run.starts_at,
        endsAt: run.ends_at,
        finishedAt: run.finished_at,
        arrived: arr.filter(a => a.state === 'arrived').length,
        alertsActive: one("SELECT count(*) n FROM jornada_alerts WHERE run_id=? AND state='active'", run.id).n,
        createdAt: run.created_at,
      };
    }
    function view(run, user) {
      const t = now(),
        arr = arrivalsOf(run.id),
        rows = conversationRows(run),
        cfg = { ...DEFAULT_ALERTS, ...parse(run.alerts, {}) },
        ids = rows.map(r => r.conversation_id).filter(Boolean),
        ph = ids.map(() => '?').join(','),
        alerts = all('SELECT * FROM jornada_alerts WHERE run_id=? ORDER BY state ASC,created_at DESC LIMIT 80', run.id);
      const activeByConv = new Map();
      for (const a of alerts)
        if (a.state === 'active') activeByConv.set(a.conversation_id, (activeByConv.get(a.conversation_id) || 0) + 1);
      const agentFirst = ids.length
        ? all(
            `SELECT c.conversation_id,MIN(g.created_at)-MAX(c.created_at) ms
             FROM messages c JOIN messages g ON g.conversation_id=c.conversation_id AND g.sender_kind='agent' AND g.created_at>c.created_at
             WHERE c.conversation_id IN (${ph}) AND c.sender_kind='customer' GROUP BY c.conversation_id`,
            ...ids,
          )
        : [];
      const paid = ids.length
        ? one(`SELECT count(*) n FROM orders WHERE conversation_id IN (${ph}) AND status='paid'`, ...ids).n
        : 0;
      const assistantOnly = rows.filter(
        r => r.conversation_id && r.agentMessages === 0 && r.status !== 'waiting' && !r.assigned_to,
      ).length;
      const waiting = rows.filter(r => r.conversation_id && r.status === 'waiting').length;
      const handled = rows.filter(r => r.agentMessages > 0).length;
      const assignee = run.assignee_id
        ? (() => {
            const mine = rows.filter(r => r.assigned_to === run.assignee_id);
            const late = mine.filter(
              r =>
                r.status !== 'resolved' &&
                r.lastCustomerAt &&
                (!r.lastOutboundAt || r.lastOutboundAt < r.lastCustomerAt) &&
                t - r.lastCustomerAt >= cfg.waitMinutes * 60_000,
            ).length;
            const mineIds = new Set(mine.map(r => r.conversation_id));
            return {
              id: run.assignee_id,
              name: userName(run.assignee_id) || 'Persona del equipo',
              open: mine.filter(r => r.status !== 'resolved').length,
              medianMs: median(agentFirst.filter(x => mineIds.has(x.conversation_id)).map(x => x.ms)),
              late,
              closedWithOrder:
                mine.length && mineIds.size
                  ? one(
                      `SELECT count(DISTINCT conversation_id) n FROM orders WHERE conversation_id IN (${[...mineIds].map(() => '?').join(',')}) AND status='paid'`,
                      ...mineIds,
                    ).n
                  : 0,
              total: mine.length,
            };
          })()
        : null;
      const elapsed = Math.max(
        0,
        Math.min(run.ends_at, run.state === 'paused' ? run.paused_at : t) - run.starts_at - run.paused_ms,
      );
      return {
        ...summary(run),
        pace: run.pace,
        paceLabel: PACES[run.pace]?.label || run.pace,
        ai: {
          mode: run.ai,
          label: run.ai === 'claude' ? 'Claude actúa cada cliente' : 'Guiones por perfil',
          available: aiAvailable(),
          capCents: run.ai_cap_cents,
          costCents: aiCost(run),
          calls: run.ai_calls || 0,
          inputTokens: run.ai_input_tokens || 0,
          outputTokens: run.ai_output_tokens || 0,
          active: aiOn(run) && ['running', 'paused', 'planned'].includes(run.state),
          note: run.ai_note || '',
          model: run.ai === 'claude' ? provider()?.model || null : null,
        },
        personas: parse(run.personas, []).map(p => ({ id: p, label: PERSONAS[p]?.label || p })),
        assigneeId: run.assignee_id,
        assigneeName: userName(run.assignee_id),
        alertsConfig: cfg,
        createdByName: userName(run.created_by),
        elapsedMs: elapsed,
        totalMs: run.minutes * 60_000,
        pausedAt: run.paused_at,
        canManage: user.role === 'admin',
        blocks: blocks({
          startAt: run.starts_at,
          minutes: run.minutes,
          arrivals: arr.map(a => ({ plannedAt: a.planned_at, state: a.state })),
          now: t,
        }),
        planned: arr.length,
        stats: {
          arrived: rows.length,
          assistantOnly,
          waiting,
          waitingOldestMs: Math.max(
            0,
            ...rows.filter(r => r.status === 'waiting' && r.lastCustomerAt).map(r => t - r.lastCustomerAt),
          ),
          handled,
          agentMedianMs: median(agentFirst.map(x => x.ms)),
          paid,
          alertsActive: alerts.filter(a => a.state === 'active').length,
        },
        assignee,
        conversations: rows.map(r => ({
          id: r.conversation_id,
          name: r.name,
          persona: r.persona,
          personaLabel: PERSONAS[r.persona]?.label || r.persona,
          channel: r.channel,
          courseTitle: r.course_title || null,
          status: r.conversation_id ? r.status : 'starting',
          state: !r.conversation_id
            ? 'starting'
            : r.status === 'resolved'
              ? 'closed'
              : r.status === 'waiting'
                ? 'waiting'
                : r.assigned_to
                  ? 'agent'
                  : 'assistant',
          assignedTo: r.assigned_to,
          assigneeName: r.assigned_to ? userName(r.assigned_to) : null,
          actorState: r.actor_state,
          outcome: r.outcome,
          arrivedAt: r.arrived_at,
          last: r.last,
          alerts: activeByConv.get(r.conversation_id) || 0,
        })),
        alerts: alerts.map(a => ({
          id: a.id,
          kind: a.kind,
          label: ALERT_KINDS[a.kind]?.label || a.kind,
          icon: ALERT_KINDS[a.kind]?.icon || '•',
          tone: ALERT_KINDS[a.kind]?.tone || 'soft',
          conversationId: a.conversation_id,
          text: a.text,
          detail: a.detail,
          state: a.state,
          createdAt: a.created_at,
          resolvedAt: a.resolved_at,
          resolvedByName: userName(a.resolved_by),
        })),
      };
    }
    // El chat de una conversación de la jornada, como texto plano, con los mensajes que fallaron marcados.
    function chat(run, conversationId) {
      const belongs = one(
        'SELECT 1 FROM jornada_arrivals ar JOIN simulator_actors a ON a.id=ar.actor_id WHERE ar.run_id=? AND a.conversation_id=?',
        run.id,
        conversationId,
      );
      if (!belongs) throw fail(404, 'Esa conversación no es de esta jornada.', { code: 'not_found' });
      const rows = all(
        'SELECT m.seq,m.sender_kind,m.text,m.created_at,m.sender_id,u.name sender_name FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=? ORDER BY m.seq LIMIT 200',
        conversationId,
      );
      return rows.map((m, i) => ({
        seq: m.seq,
        kind: m.sender_kind,
        text: String(m.text || ''),
        at: m.created_at,
        who:
          m.sender_kind === 'customer'
            ? 'Cliente simulado'
            : m.sender_kind === 'automation'
              ? 'Asistente'
              : m.sender_name || 'Equipo',
        flag:
          m.sender_kind === 'automation' && NO_SUPO.test(String(m.text || ''))
            ? 'no_supo'
            : m.sender_kind === 'automation' &&
                HANDOFF.test(String(m.text || '')) &&
                /^(ok|gracias|vale|listo|perfecto)[.!\s]*$/i.test(String(rows[i - 1]?.text || '').trim())
              ? 'paso_sin_motivo'
              : null,
      }));
    }

    // ---- informe
    function report(run, user) {
      const v = view(run, user);
      let byPersona = {};
      try {
        byPersona = run.simulator_run_id ? sim().view(run.simulator_run_id)?.stats?.byPersona || {} : {};
      } catch {
        byPersona = {};
      }
      return buildReport({
        alerts: v.alerts,
        conversations: v.conversations,
        byPersona,
        stats: v.stats,
        personaLabels: Object.fromEntries(Object.entries(PERSONAS).map(([k, p]) => [k, p.label])),
      });
    }
    // Un borrador de conocimiento con la pregunta que el asistente no supo (una persona lo completa y aprueba).
    function draftKnowledge(run, question, user) {
      const q = String(question || '')
        .trim()
        .slice(0, 300);
      if (q.length < 3) throw fail(400, 'Falta la pregunta.');
      const existing = one(
        "SELECT id FROM knowledge_entries WHERE brand_id=? AND status!='archived' AND lower(question)=lower(?)",
        run.brand_id,
        q,
      );
      if (existing) return { entry: { id: existing.id }, created: false };
      const e = host.services.replies.createEntry(user, {
        brandId: run.brand_id,
        topic: 'general',
        question: q,
        variants: [],
        answer:
          'Por completar por el equipo: el asistente no supo contestar esto en la jornada simulada «' +
          run.title +
          '».',
      });
      audit(user, 'jornada.report.knowledge', e.id);
      return { entry: e, created: true };
    }
    // Casos para el banco de evaluación: el mensaje del cliente y lo que debía pasar (por omisión, contestar).
    function addCases(run, cases, user) {
      const list = (Array.isArray(cases) ? cases : []).slice(0, 10);
      const made = [];
      for (const c of list) {
        const inputText = String(c?.inputText || '')
          .trim()
          .slice(0, 500);
        if (inputText.length < 3) continue;
        const made1 = host.services.evaluation.create(
          {
            brandId: run.brand_id,
            title: String(c?.title || 'Jornada simulada: ' + inputText).slice(0, 120),
            inputText,
            expectAction: ['replied', 'suggested', 'escalated', 'skipped'].includes(c?.expectAction)
              ? c.expectAction
              : 'replied',
            tags: 'jornada',
          },
          user,
        );
        made.push(made1);
      }
      audit(user, 'jornada.report.evaluation', run.id);
      return made;
    }

    // ---- acciones
    function pause(run, user) {
      if (run.state !== 'running') throw fail(409, 'Sólo se pausa una jornada en curso.');
      db.prepare("UPDATE jornada_runs SET state='paused',paused_at=?,updated_at=? WHERE id=?").run(
        now(),
        now(),
        run.id,
      );
      audit(user, 'jornada.pause', run.id);
    }
    function resume(run, user) {
      if (run.state !== 'paused') throw fail(409, 'La jornada no está en pausa.');
      const t = now(),
        gap = t - run.paused_at;
      host.transaction(db, () => {
        db.prepare("UPDATE jornada_arrivals SET planned_at=planned_at+? WHERE run_id=? AND state='planned'").run(
          gap,
          run.id,
        );
        db.prepare(
          "UPDATE jornada_runs SET state='running',paused_at=NULL,paused_ms=paused_ms+?,ends_at=ends_at+?,updated_at=? WHERE id=?",
        ).run(gap, gap, t, run.id);
      });
      audit(user, 'jornada.resume', run.id);
    }
    function finish(run, user) {
      if (!['running', 'paused', 'planned'].includes(run.state)) throw fail(409, 'La jornada ya terminó.');
      const t = now();
      host.transaction(db, () => {
        db.prepare("UPDATE jornada_arrivals SET state='skipped' WHERE run_id=? AND state='planned'").run(run.id);
        db.prepare("UPDATE jornada_runs SET state='finished',finished_at=?,updated_at=? WHERE id=?").run(t, t, run.id);
      });
      if (run.simulator_run_id) {
        const s = sim().getRun(run.simulator_run_id);
        if (s && s.state === 'running') sim().stop(s, user);
      }
      audit(user, 'jornada.finish', run.id);
    }
    function archive(run, user) {
      if (run.state !== 'finished') throw fail(409, 'Termina la jornada antes de archivarla.');
      if (run.simulator_run_id) {
        const s = sim().getRun(run.simulator_run_id);
        if (s && s.state !== 'archived') sim().archive(s, user);
      }
      db.prepare("UPDATE jornada_runs SET state='archived',updated_at=? WHERE id=?").run(now(), run.id);
      db.prepare(
        "UPDATE jornada_alerts SET state='resolved',resolved_at=COALESCE(resolved_at,?) WHERE run_id=? AND state='active'",
      ).run(now(), run.id);
      audit(user, 'jornada.archive', run.id);
    }

    async function handle(req, res, path, user, url) {
      host.requireStaff(user);
      if (user.role !== 'admin') throw fail(403, 'La jornada simulada es sólo para administración.');
      const brand = url?.searchParams.get('brand') || '';
      if (path === '/api/jornada' && req.method === 'GET') {
        const brandId = brand && brand !== 'all' ? brand : null;
        if (brandId && !crm.canBrand(user, brandId)) throw fail(404, 'Marca no disponible.', { code: 'not_found' });
        const runs = all(
          `SELECT * FROM jornada_runs WHERE ${brandId ? 'brand_id=? AND ' : ''}state!='archived' ORDER BY created_at DESC LIMIT 20`,
          ...(brandId ? [brandId] : []),
        ).filter(r => crm.canBrand(user, r.brand_id));
        json(res, 200, {
          enabled: Boolean(sim()),
          runs: runs.map(summary),
          options: {
            personas: Object.entries(PERSONAS).map(([id, p]) => ({ id, label: p.label, description: p.description })),
            rhythms: Object.entries(RHYTHMS).map(([id, r]) => ({ id, ...r })),
            paces: Object.entries(PACES).map(([id, p]) => ({ id, label: p.label })),
            alertKinds: Object.entries(ALERT_KINDS).map(([id, a]) => ({ id, ...a })),
            defaultAlerts: DEFAULT_ALERTS,
            limits: LIMITS,
            ai: { available: aiAvailable(), model: aiAvailable() ? provider().model : null, defaultCapUsd: 3 },
            brands: all('SELECT id,name FROM brands ORDER BY name').filter(b => crm.canBrand(user, b.id)),
            team: all(
              "SELECT id,name,role FROM users WHERE role IN ('admin','agent') AND (disabled IS NULL OR disabled=0) ORDER BY name",
            ),
          },
        });
        return true;
      }
      if (path === '/api/jornada' && req.method === 'POST') {
        json(res, 201, { run: create(await body(req), user) });
        return true;
      }
      let m = path.match(new RegExp(`^/api/jornada/(${UUID})$`));
      if (m && req.method === 'GET') {
        const run = getRun(m[1]);
        if (!run || !crm.canBrand(user, run.brand_id)) throw fail(404, 'Jornada no encontrada.', { code: 'not_found' });
        json(res, 200, { run: view(run, user) });
        return true;
      }
      m = path.match(new RegExp(`^/api/jornada/(${UUID})/conversations/(${UUID})$`));
      if (m && req.method === 'GET') {
        const run = getRun(m[1]);
        if (!run || !crm.canBrand(user, run.brand_id)) throw fail(404, 'Jornada no encontrada.', { code: 'not_found' });
        json(res, 200, { messages: chat(run, m[2]) });
        return true;
      }
      m = path.match(new RegExp(`^/api/jornada/(${UUID})/report(?:/(knowledge|evaluation))?$`));
      if (m) {
        const run = getRun(m[1]);
        if (!run || !crm.canBrand(user, run.brand_id)) throw fail(404, 'Jornada no encontrada.', { code: 'not_found' });
        if (!m[2] && req.method === 'GET') {
          json(res, 200, { report: report(run, user) });
          return true;
        }
        if (m[2] === 'knowledge' && req.method === 'POST') {
          const input = await body(req);
          json(res, 201, draftKnowledge(run, input?.question, user));
          return true;
        }
        if (m[2] === 'evaluation' && req.method === 'POST') {
          const input = await body(req);
          json(res, 201, { cases: addCases(run, input?.cases, user) });
          return true;
        }
        throw fail(405, 'Método no permitido.');
      }
      m = path.match(new RegExp(`^/api/jornada/(${UUID})/alerts/(${UUID})/resolve$`));
      if (m && req.method === 'POST') {
        const run = getRun(m[1]);
        if (!run || !crm.canBrand(user, run.brand_id)) throw fail(404, 'Jornada no encontrada.', { code: 'not_found' });
        const n = db
          .prepare(
            "UPDATE jornada_alerts SET state='resolved',resolved_at=?,resolved_by=? WHERE id=? AND run_id=? AND state='active'",
          )
          .run(now(), user.id, m[2], run.id).changes;
        if (!n) throw fail(409, 'Esa alerta ya estaba resuelta.');
        emit(run);
        json(res, 200, { run: view(run, user) });
        return true;
      }
      m = path.match(new RegExp(`^/api/jornada/(${UUID})/(pause|resume|finish|archive)$`));
      if (m && req.method === 'POST') {
        const run = getRun(m[1]);
        if (!run || !crm.canBrand(user, run.brand_id)) throw fail(404, 'Jornada no encontrada.', { code: 'not_found' });
        ({ pause, resume, finish, archive })[m[2]](run, user);
        emit(run);
        json(res, 200, { run: view(getRun(run.id), user) });
        return true;
      }
      return false;
    }
    return { handle, tick, create, view: (id, user) => view(getRun(id), user) };
  },
};
