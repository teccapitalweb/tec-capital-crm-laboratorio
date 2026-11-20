// Motor de las secuencias de seguimiento (docs/PLAN_SECUENCIAS.md; diseño de automatización §5.8).
//
// Cada mensaje de una secuencia es un paso durable `sequence.send` de la cola de automatización (server/automation.mjs:
// arrendamiento, reintentos, sobrevive a un reinicio). Su clave es `seq:<inscripción>:<índice>:<schedule_seq>` y el
// mensaje lleva `client_ref = seq:<inscripción>:<índice>`: si el paso se ejecuta dos veces (arrendamiento vencido,
// reinicio), el mensaje no se repite. Todo lo que decide un envío se vuelve a mirar en `commit`, DENTRO de la misma
// transacción que marca el paso como hecho e inserta el mensaje: una persona que se inscribió o pidió la baja hace
// cinco minutos no recibe nada.
//
// Respuestas: modelo de consulta. No hay gancho en el entrante; se leen los mensajes de la persona desde el último
// paso (`reply_seen_seq`) cuando toca el siguiente y en un barrido periódico. Lo que contesta a la persona sigue siendo
// lo de siempre (un recorrido por palabra clave, el asistente).
//
// Todo depende de `deps` (inyectadas por module.mjs; dobles en las pruebas) y del reloj `now` inyectable. Sin red.
import { randomUUID } from 'node:crypto';
import { evaluate as evaluateConditions } from '../../lib/conditions.mjs';
import { cancelSteps } from '../../automation.mjs';
import { isOpen, nextOpening } from '../../service-hours.mjs';
import { inQuietHours } from '../broadcasts/model.mjs';
import { CONDITION_FIELDS } from '../chatflows/engine.mjs';
import {
  DAY,
  HOUR,
  LIMITS,
  MINUTE,
  classifyReply,
  editionOver,
  monthStart,
  normalizeSettings,
  stepTiming,
  zonedInstant,
  zonedParts,
} from './model.mjs';

export const STEP_KIND = 'sequence.send';
const SWEEP_ROWS = 100;
const FLOW_RECHECK = 10 * MINUTE; // cada cuánto vuelve a mirar un paso que espera a que termine un recorrido

export function createEngine({ db, repo, deps, now = Date.now, log = console }) {
  const settingsOf = seq => normalizeSettings(seq?.settings ?? {});
  const timezoneOf = brandId => deps.policy(brandId)?.timezone || 'America/Mexico_City';

  function event(e, ev, at) {
    repo.insertEvent({
      brandId: e.brand_id,
      sequenceId: e.sequence_id,
      enrollmentId: e.id,
      conversationId: e.conversation_id,
      at,
      ...ev,
    });
  }
  const cancelPending = (e, reason, at) => cancelSteps(db, repo.pendingStepsOf(e.id), reason, null, at);

  function finish(e, state, reason, at) {
    e.state = state;
    e.reason = reason;
    e.ended_at = at;
    e.next_due_at = null;
    repo.saveEnrollment(e, at);
    cancelPending(e, 'sequence_' + state, at);
    event(e, { event: state, detail: reason, stepIndex: e.last_step_index ?? null }, at);
    deps.changed?.(e.brand_id, { sequenceId: e.sequence_id, enrollmentId: e.id, state, reason });
  }
  function pause(e, reason, at) {
    e.state = 'paused';
    e.reason = reason;
    e.paused_at = at;
    e.next_due_at = null;
    repo.saveEnrollment(e, at);
    cancelPending(e, 'sequence_paused', at);
    event(e, { event: 'paused', detail: reason, stepIndex: e.last_step_index ?? null }, at);
    deps.changed?.(e.brand_id, { sequenceId: e.sequence_id, enrollmentId: e.id, state: 'paused', reason });
  }

  // Programa el paso `next_index` (u omite los que ya no pueden salir) a su hora. Dentro de una transacción.
  function arm(e, at, t) {
    e.schedule_seq += 1;
    e.next_due_at = at;
    repo.saveEnrollment(e, t);
    deps.enqueueInTx({
      brandId: e.brand_id,
      conversationId: e.conversation_id,
      kind: STEP_KIND,
      payload: { enrollmentId: e.id, index: e.next_index, seq: e.schedule_seq },
      dedupeKey: `seq:${e.id}:${e.next_index}:${e.schedule_seq}`,
      scheduledAt: at,
      maxAttempts: 4,
    });
  }
  function scheduleNext(e, t) {
    const steps = e.definition.steps;
    const edition = e.edition_id ? repo.edition(e.brand_id, e.edition_id) : null;
    const timeZone = timezoneOf(e.brand_id);
    while (e.next_index < steps.length) {
      const timing = stepTiming(steps[e.next_index], { startedAt: e.started_at, edition, timeZone });
      const why = timing.reason ?? (t > timing.latest ? 'too_late' : null);
      if (!why) return arm(e, Math.max(timing.due, t), t);
      event(e, { event: 'skipped', detail: why, stepIndex: e.next_index }, t);
      e.next_index += 1;
    }
    finish(e, 'completed', 'completed', t);
  }

  // ---- ¿Se puede inscribir? Motivo o null.
  function refusal(c, seq) {
    if (!seq || seq.archived_at || !seq.enabled) return 'sequence_off';
    if (!c || c.brand_id !== seq.brand_id) return 'not_found';
    if (!deps.speaks(seq.brand_id)) return 'automation_off';
    if (seq.course_id && c.course_id !== seq.course_id) return 'other_course';
    if (c.state === 'blocked') return 'blocked';
    if (c.status === 'resolved') return 'closed';
    const contactId = repo.contactId(c.id);
    if (repo.consent(contactId) === 'opted_out') return 'opt_out';
    if (contactId && deps.suppressed(seq.brand_id, contactId)) return 'suppressed';
    if (repo.paid(c.id, contactId, c.course_id)) return 'enrolled';
    if (repo.live(seq.brand_id, seq.id, c.id)) return 'already_enrolled';
    return null;
  }

  // Inscribe dentro de la transacción de quien llama (un recorrido, una regla o la ruta del equipo).
  // → {enrollment, duplicate} | {refused: motivo}
  function enrollInTx(c, seq, { source = 'manual', userId = null, clientRef = null } = {}) {
    const t = now();
    if (clientRef) {
      const existing = repo.enrollmentByRef(seq.brand_id, clientRef);
      if (existing) return { enrollment: existing, duplicate: true };
    }
    const why = refusal(c, seq);
    if (why) return { refused: why };
    const edition =
      (c.edition_id ? repo.edition(c.brand_id, c.edition_id) : null) ?? repo.nextEdition(c.brand_id, c.course_id, t);
    const id = randomUUID();
    repo.insertEnrollment({
      id,
      sequenceId: seq.id,
      brandId: seq.brand_id,
      conversationId: c.id,
      sequenceRevision: seq.revision,
      definition: { steps: seq.steps },
      courseId: c.course_id,
      editionId: edition?.id ?? null,
      replySeenSeq: repo.maxCustomerSeq(c.id),
      source,
      userId,
      clientRef,
      at: t,
    });
    const e = repo.enrollment(seq.brand_id, id);
    event(e, { event: 'enrolled', detail: source }, t);
    scheduleNext(e, t);
    deps.changed?.(seq.brand_id, { sequenceId: seq.id, enrollmentId: id, state: e.state });
    return { enrollment: repo.enrollment(seq.brand_id, id), duplicate: false };
  }

  // ---- Lo que toca hacer con una inscripción en este momento. PURA: no escribe (la usan el envío y la vista previa).
  //   {stop}  {pause}  {complete}  {skip}  {wait: {at, reason}}  {send: plan}   + `events` y `seen` de las respuestas.
  function replyVerdict(e, seq, c, out) {
    const msgs = repo.customerMessagesAfter(c.id, e.reply_seen_seq);
    if (!msgs.length) return null;
    out.seen = msgs.at(-1).seq;
    const settings = settingsOf(seq);
    if (e.last_sent_at == null) {
      // Lo escrito antes del primer paso no es una respuesta a la secuencia, pero una baja o un «no» sí cuentan: a
      // quien ya dijo que no, no se le manda ni el primer mensaje.
      if (msgs.some(m => deps.isOptOutText(m.text))) return { stop: 'opt_out' };
      if (msgs.some(m => classifyReply(m.text, settings) === 'no')) return { stop: 'said_no' };
      return null;
    }
    const step = e.last_step_index;
    out.events.push({ event: 'replied', stepIndex: step });
    if (msgs.some(m => deps.isOptOutText(m.text))) return { stop: 'opt_out' };
    const kinds = msgs.map(m => classifyReply(m.text, settings));
    if (kinds.includes('no')) {
      out.events.push({ event: 'said_no', stepIndex: step });
      return { stop: 'said_no' };
    }
    if (kinds.includes('yes')) out.events.push({ event: 'said_yes', stepIndex: step });
    return settings.onReply === 'stop' ? { stop: 'replied' } : { pause: 'replied' };
  }

  function sendableAt(brandId, t, mode) {
    if (mode === 'daytime') {
      const q = repo.quietHours(brandId) ?? { start: '21:00', end: '08:00' };
      const zone = timezoneOf(brandId);
      for (let x = t, i = 0; i <= 24 * 12; i++, x += 5 * MINUTE) if (!inQuietHours(x, zone, q.start, q.end)) return x;
      return t + DAY;
    }
    const policy = deps.policy(brandId);
    if (!policy?.hours || isOpen(t, policy)) return t;
    return nextOpening(t, policy) ?? t + DAY;
  }

  function templatePlan(c, settings, consent, templateId) {
    if (!c.wa_number) return { skip: 'template_unavailable', detail: 'conversación del laboratorio, sin número real' };
    const tpl = deps.template(c, templateId);
    if (!tpl || tpl.reason) return { skip: 'template_unavailable', detail: tpl?.reason ?? null };
    if (tpl.category === 'marketing' && settings.requireConsent && consent !== 'opted_in')
      return { skip: 'no_consent' };
    return {
      send: { kind: 'template', text: tpl.text, category: tpl.category, template: tpl.template, buttons: tpl.buttons },
    };
  }

  function evaluate(e, t) {
    const out = { events: [], seen: null };
    const done = v => Object.assign(out, v);
    const seq = repo.sequence(e.brand_id, e.sequence_id);
    if (!seq || seq.archived_at || !seq.enabled) return done({ stop: 'sequence_off' });
    if (!deps.speaks(e.brand_id)) return done({ stop: 'automation_off' });
    const c = repo.conversation(e.brand_id, e.conversation_id);
    if (!c) return done({ stop: 'closed' });
    if (c.state === 'blocked') return done({ stop: 'blocked' });
    if (c.status === 'resolved') return done({ stop: 'closed' });
    const contactId = repo.contactId(c.id);
    const consent = repo.consent(contactId);
    if (consent === 'opted_out') return done({ stop: 'opt_out' });
    if (contactId && deps.suppressed(e.brand_id, contactId)) return done({ stop: 'suppressed' });
    if (repo.paid(c.id, contactId, e.course_id)) return done({ stop: 'enrolled' });
    const replied = replyVerdict(e, seq, c, out);
    if (replied) return done(replied);
    const settings = settingsOf(seq);
    if (!c.bot_enabled || c.assigned_to)
      return done(settings.onTakeover === 'stop' ? { stop: 'human_takeover' } : { pause: 'human_takeover' });
    const edition = e.edition_id ? repo.edition(e.brand_id, e.edition_id) : null;
    const timeZone = timezoneOf(e.brand_id);
    const over = editionOver(edition, t, timeZone);
    if (over) return done({ stop: over });
    const index = e.next_index;
    const step = e.definition.steps[index];
    if (!step) return done({ complete: true });
    out.index = index;
    const timing = stepTiming(step, { startedAt: e.started_at, edition, timeZone });
    if (timing.reason) return done({ skip: timing.reason });
    if (t > timing.latest) return done({ skip: 'too_late' });
    if (t < timing.due) return done({ wait: { at: timing.due, reason: 'not_due' } });
    // Un recorrido atiende la conversación (enviando o esperando la respuesta de la persona): la secuencia no habla a
    // la vez. Vuelve a mirar en unos minutos; un recorrido termina como mucho a las 24 horas (su tiempo límite), dentro
    // de la holgura del paso.
    if (deps.flowActive?.(c)) return done({ wait: { at: t + FLOW_RECHECK, reason: 'flow_active' } });
    if (step.condition) {
      let ok = false;
      try {
        ok = evaluateConditions(step.condition, deps.conditionRecord(c, contactId, t), CONDITION_FIELDS, t);
      } catch {
        ok = false;
      }
      if (!ok) return done({ skip: 'condition' });
    }
    if (c.wa_number) {
      const verdict = deps.canSend(c);
      if (verdict && verdict.ok === false) return done({ stop: 'listen_only' });
    }
    const allowed = sendableAt(e.brand_id, t, settings.sendHours);
    if (allowed > t) return done({ wait: { at: allowed, reason: 'outside_hours' } });
    if (repo.monthSends(e.sequence_id, monthStart(t, timeZone)) >= settings.monthlyCap) {
      const p = zonedParts(t, timeZone);
      const next = zonedInstant(
        { year: p.month === 12 ? p.year + 1 : p.year, month: p.month === 12 ? 1 : p.month + 1, day: 1 },
        9,
        0,
        timeZone,
      );
      return done({ wait: { at: Math.min(next, t + DAY), reason: 'monthly_cap' } });
    }
    const recent = repo.recentSends(e.brand_id, c.id, contactId, t - DAY);
    if (recent.length >= LIMITS.perPersonPerDay) {
      const freeAt = recent[recent.length - LIMITS.perPersonPerDay] + DAY + MINUTE;
      return done({ wait: { at: Math.max(freeAt, t + MINUTE), reason: 'frequency_cap' } });
    }
    // Contenido: una plantilla sale aunque la ventana esté cerrada; lo demás sólo con la ventana abierta.
    if (step.send.kind === 'template') return done(templatePlan(c, settings, consent, step.send.templateId));
    if (!deps.windowOpen(c)) {
      if (step.whenClosed === 'template') return done(templatePlan(c, settings, consent, step.fallbackTemplateId));
      if (step.whenClosed === 'stop') return done({ stop: 'window_closed' });
      return done({ skip: 'window_closed' });
    }
    if (step.send.kind === 'material') {
      const m = deps.material(c, step.send.materialId);
      if (!m || m.reason) return done({ skip: 'material_unavailable', detail: m?.reason ?? null });
      return done({ send: { kind: 'material', text: m.text, prepared: m.prepared, category: 'service' } });
    }
    const first = repo.customerName(c.id).split(' ')[0] || '';
    const text = step.send.text.replace(/\{\{\s*nombre\s*\}\}/g, first);
    return done({ send: { kind: 'text', text: deps.realText(e.brand_id, text), category: 'service' } });
  }

  // Aplica lo decidido. Dentro de la transacción del paso (o del barrido).
  function apply(e, v, t) {
    for (const ev of v.events) event(e, ev, t);
    if (v.seen != null) e.reply_seen_seq = Math.max(e.reply_seen_seq, v.seen);
    if (v.stop) return (finish(e, 'stopped', v.stop, t), { stopped: v.stop });
    if (v.pause) return (pause(e, v.pause, t), { paused: v.pause });
    if (v.complete) return (finish(e, 'completed', 'completed', t), { completed: true });
    if (v.skip) {
      event(e, { event: 'skipped', detail: v.skip, stepIndex: v.index }, t);
      e.next_index += 1;
      scheduleNext(e, t);
      return { skipped: v.skip };
    }
    if (v.wait) {
      // La espera a que termine un recorrido se anota una vez, no en cada vuelta.
      const last = v.wait.reason === 'flow_active' ? repo.lastEvent(e.id) : null;
      const again = last?.event === 'waiting' && last.detail === 'flow_active' && last.step_index === v.index;
      if (v.wait.reason !== 'not_due' && !again)
        event(e, { event: 'waiting', detail: v.wait.reason, stepIndex: v.index }, t);
      arm(e, v.wait.at, t);
      return { waiting: v.wait.reason, at: v.wait.at };
    }
    if (v.send) {
      const c = repo.conversation(e.brand_id, e.conversation_id);
      const ref = `seq:${e.id}:${v.index}`;
      const existing = repo.messageByRef(ref);
      const messageId = existing?.id ?? deps.insertMessage(c, v.send, ref);
      event(e, { event: 'sent', detail: v.send.category, stepIndex: v.index, messageId }, t);
      e.last_sent_at = t;
      e.last_step_index = v.index;
      e.reply_seen_seq = Math.max(e.reply_seen_seq, repo.maxCustomerSeq(c.id));
      e.next_index += 1;
      scheduleNext(e, t);
      deps.conversationChanged?.(c.id);
      return { sent: messageId, index: v.index };
    }
    return {};
  }

  // ---- el paso durable
  const handler = {
    check(step) {
      const e = repo.enrollment(step.brand_id, step.payload.enrollmentId);
      if (!e || e.state !== 'active') return { cancel: 'enrollment_' + (e?.state ?? 'gone') };
      if (e.schedule_seq !== step.payload.seq || e.next_index !== step.payload.index) return { cancel: 'moved' };
      return null;
    },
    commit(step) {
      const e = repo.enrollment(step.brand_id, step.payload.enrollmentId);
      const t = now();
      return apply(e, evaluate(e, t), t);
    },
  };

  // ---- gancho de cancelación (toma humana, cierre, baja): dentro de la transacción de quien llama
  function onCancel(conversationId, reason) {
    try {
      const t = now();
      for (const e of repo.liveOfConversation(conversationId)) {
        if (reason === 'contact_opted_out') finish(e, 'stopped', 'opt_out', t);
        else if (reason === 'human_takeover' || reason === 'owner_changed') {
          if (e.state !== 'active') continue;
          const seq = repo.sequence(e.brand_id, e.sequence_id);
          if (settingsOf(seq).onTakeover === 'stop') finish(e, 'stopped', 'human_takeover', t);
          else pause(e, 'human_takeover', t);
        } else {
          const c = repo.conversation(e.brand_id, conversationId);
          if (!c || c.status === 'resolved') finish(e, 'stopped', 'closed', t);
          else if (c.state === 'blocked') finish(e, 'stopped', 'blocked', t);
          // si sigue abierta, el barrido vuelve a programar su paso (el que se canceló)
        }
      }
    } catch (error) {
      log.error('Sequence cancel hook failed', error?.name, String(error?.message || '').slice(0, 160));
    }
  }

  // ---- acciones del equipo
  function stop(e, at = now()) {
    if (!['active', 'paused'].includes(e.state)) return e;
    finish(e, 'stopped', 'manual', at);
    return e;
  }
  function resume(e, at = now()) {
    if (e.state !== 'paused') return e;
    e.state = 'active';
    e.reason = null;
    e.paused_at = null;
    e.reply_seen_seq = Math.max(e.reply_seen_seq, repo.maxCustomerSeq(e.conversation_id));
    event(e, { event: 'resumed', stepIndex: e.last_step_index ?? null }, at);
    scheduleNext(e, at);
    deps.changed?.(e.brand_id, { sequenceId: e.sequence_id, enrollmentId: e.id, state: e.state });
    return e;
  }
  // Apagar o archivar una secuencia detiene en el acto sus inscripciones vivas.
  function stopAll(brandId, sequenceId, reason, at = now()) {
    let n = 0;
    for (const e of repo.liveOfSequence(brandId, sequenceId)) {
      finish(e, 'stopped', reason, at);
      n++;
    }
    return n;
  }

  // ---- barrido periódico (cada parte en su transacción, con tope de filas)
  function sweep(transaction) {
    const t = now();
    const out = { stopped: 0, replies: 0, resumed: 0, rearmed: 0, enrolled: 0 };
    // 1. Marca sin automatización (o su asistente ya no responde solo): se detiene lo vivo.
    for (const brandId of repo.liveBrands())
      if (!deps.speaks(brandId))
        transaction(() => {
          for (const e of repo.liveOfBrand(brandId, SWEEP_ROWS)) {
            finish(e, 'stopped', 'automation_off', t);
            out.stopped++;
          }
        });
    // 2. Respuestas desde el último paso: pausa o alto en cuanto se ven, sin esperar al paso siguiente.
    transaction(() => {
      for (const e of repo.withReplies(SWEEP_ROWS)) {
        const seq = repo.sequence(e.brand_id, e.sequence_id);
        const c = repo.conversation(e.brand_id, e.conversation_id);
        if (!seq || !c) continue;
        const v = { events: [], seen: null };
        const verdict = replyVerdict(e, seq, c, v);
        if (verdict) {
          apply(e, { ...v, ...verdict }, t);
          out.replies++;
        }
      }
    });
    // 3. Reanudar sola una pausa por respuesta o por toma humana: la conversación volvió a la automatización y la
    //    persona lleva `resumeAfterHours` sin escribir.
    transaction(() => {
      for (const e of repo.resumable(SWEEP_ROWS)) {
        const seq = repo.sequence(e.brand_id, e.sequence_id);
        const hours = settingsOf(seq).resumeAfterHours;
        if (!seq?.enabled || seq.archived_at || hours <= 0) continue;
        const c = repo.conversation(e.brand_id, e.conversation_id);
        if (!c || !c.bot_enabled || c.assigned_to || c.status === 'resolved' || c.state === 'blocked') continue;
        const quietSince = Math.max(e.paused_at ?? 0, repo.lastCustomerAt(c.id) ?? 0);
        if (t - quietSince < hours * HOUR) continue;
        resume(e, t);
        out.resumed++;
      }
    });
    // 4. Inscripciones en curso sin paso vivo (se canceló al tomar o cerrar, o se perdió): se vuelven a programar.
    transaction(() => {
      for (const e of repo.orphans(SWEEP_ROWS)) {
        if (!deps.speaks(e.brand_id)) continue;
        if (repo.stepFailed(e)) {
          finish(e, 'stopped', 'step_failed', t); // agotó sus intentos: se detiene y queda a la vista con su motivo
          out.stopped++;
          continue;
        }
        arm(e, Math.max(e.next_due_at ?? t, t), t);
        out.rearmed++;
      }
    });
    // 5. Entrada automática por disparador.
    for (const seq of repo.triggered()) out.enrolled += transaction(() => triggerScan(seq));
    return out;
  }

  function triggerScan(seq) {
    if (!deps.speaks(seq.brand_id)) return 0;
    const settings = settingsOf(seq);
    const rows =
      settings.trigger === 'enroll_interest'
        ? repo.enrollAsks(seq.brand_id, seq.course_id, seq.trigger_cursor, 200)
        : repo.courseCards(seq.brand_id, seq.course_id, seq.trigger_cursor, 200);
    let n = 0;
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.conversation_id)) continue;
      seen.add(row.conversation_id);
      // Una vez por conversación: quien ya estuvo en esta secuencia no vuelve a entrar sola.
      if (repo.everEnrolled(seq.brand_id, seq.id, row.conversation_id)) continue;
      const c = repo.conversation(seq.brand_id, row.conversation_id);
      if (!c || !c.bot_enabled || c.assigned_to) continue;
      if (enrollInTx(c, seq, { source: 'trigger' }).enrollment) n++;
    }
    if (rows.length) repo.setCursor(seq.id, rows.at(-1).seq);
    return n;
  }

  // ---- vista previa: no escribe nada
  function preview(seq, { sinceDays = 14, limit = 50 } = {}) {
    const t = now();
    const settings = settingsOf(seq);
    const ids = repo.candidates(
      seq.brand_id,
      seq.course_id,
      settings.trigger === 'enroll_interest' ? 'enroll_interest' : 'course_card',
      t - sinceDays * DAY,
      500,
    );
    const asIfOn = { ...seq, enabled: true, archived_at: null };
    const excluded = {};
    const enter = [];
    for (const id of ids) {
      const c = repo.conversation(seq.brand_id, id);
      const why = refusal(c, asIfOn) ?? (repo.everEnrolled(seq.brand_id, seq.id, id) ? 'already_enrolled' : null);
      if (why) excluded[why] = (excluded[why] ?? 0) + 1;
      else enter.push({ conversationId: id, name: repo.customerName(id) });
    }
    const due = repo.dueOfSequence(seq.brand_id, seq.id, t, limit).map(e => {
      const v = evaluate(e, t);
      const outcome = v.send
        ? 'send'
        : v.stop
          ? 'stop'
          : v.pause
            ? 'pause'
            : v.skip
              ? 'skip'
              : v.wait
                ? 'wait'
                : 'complete';
      return {
        enrollmentId: e.id,
        conversationId: e.conversation_id,
        name: repo.customerName(e.conversation_id),
        step: v.index ?? e.next_index,
        outcome,
        reason: v.stop ?? v.pause ?? v.skip ?? v.wait?.reason ?? null,
        at: v.wait?.at ?? null,
        kind: v.send?.kind ?? null,
        category: v.send?.category ?? null,
      };
    });
    return {
      trigger: settings.trigger,
      sinceDays,
      enter: { count: enter.length, sample: enter.slice(0, 20), excluded },
      due,
    };
  }

  return {
    enrollInTx,
    refusal,
    evaluate,
    apply,
    handler,
    onCancel,
    stop,
    resume,
    stopAll,
    sweep,
    preview,
    scheduleNext,
  };
}
