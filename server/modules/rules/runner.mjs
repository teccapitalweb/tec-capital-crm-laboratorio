// Ejecución de las reglas por mensaje (docs/PLAN_REGLAS.md; diseño de automatización §3.2, §3.3, §5.5 y §5.6).
//
//   inbound(c, m)  lo llama el despachador (server/app/dispatch.mjs, ORDER.rules) dentro de la transacción del trabajo
//                  del asistente, ANTES que los recorridos. Si hay un recorrido en curso le cede el turno (devuelve
//                  null). Si no, evalúa las reglas activas de la marca en el orden de su lista: las acciones
//                  silenciosas de todas las que coinciden corren; sólo la primera que coincide con voz o control habla.
//                  Si alguna habló devuelve {done: true}; si no, null (sigue un recorrido que arranca o el asistente).
//   explain(…)     la misma decisión, sin escribir ni enviar nada, para «Probar» y el panel del orden de atención.
//
// Seguridad, igual que los recorridos: sólo con la automatización de la marca encendida y su asistente respondiendo
// solo («Plantillas» o «Autónomo»); nunca con una persona a cargo; todo mensaje sale por host.insertMessage (ventana de
// 24 horas, modo escucha, entrega); nunca confirma un pago; precios, fechas y cupos salen del catálogo. Cada regla corre
// en su SAVEPOINT: si falla, lo suyo se deshace, queda anotada como «falló» y siguen las demás y después el resto del
// orden. Sin reglas activas en la marca no lee ni escribe nada más: el comportamiento es el de siempre.
import { randomUUID } from 'node:crypto';
import { cancelConversationSteps } from '../../automation.mjs';
import { keywordMatch, matcher } from '../../lib/conditions.mjs';
import { forBrand } from '../../lib/real-mode.mjs';
import { isOpen } from '../../service-hours.mjs';
import { templateValues } from '../../catalogue.mjs';
import { tokensIn } from '../../../public/kit/shared/flow-model.js';
import { ACTIONS, FIELDS, kindOf, ordered, triggerMatch } from './definition.mjs';

const SPEAKS = ['templates', 'autonomous'];

// Motivos de una acción omitida, en palabras de quien mira la bitácora.
export const REASONS = Object.freeze({
  voice_taken: 'Otra regla de más arriba ya respondió este mensaje.',
  window_closed: 'La ventana de 24 horas está cerrada.',
  opted_out: 'La persona pidió no recibir mensajes.',
  listen_only: 'El número está en modo escucha.',
  consecutive_cap: 'Se llegó al tope de respuestas seguidas de reglas: contesta el asistente.',
  no_contact: 'La conversación no tiene contacto.',
  already_tagged: 'El contacto ya tenía la etiqueta.',
  not_tagged: 'El contacto no tenía la etiqueta.',
  tag_unavailable: 'La etiqueta ya no existe o el contacto llegó al máximo de etiquetas.',
  material_unavailable: 'El material no está aprobado para este curso, edición y canal.',
  course_unknown: 'Todavía no se sabe qué curso le interesa.',
  flow_unavailable: 'El recorrido no está publicado y activo.',
  flow_active: 'Ya hay un recorrido en curso.',
  flow_silent: 'El recorrido terminó sin decir nada.',
  assign_failed: 'No se pudo asignar a la persona elegida.',
  status_unavailable: 'No se puede pasar a ese estado ahora.',
  duplicate: 'Ya se había enviado.',
});

// Datos {{…}} de un texto: los del catálogo y la persona, y los del contacto. Las variables de recorrido no existen
// aquí (la validación ya las rechazó); un dato vacío deja su respaldo o nada.
export function renderText(body, values) {
  const text = String(body ?? '');
  const tokens = tokensIn(text);
  if (!tokens.length) return text;
  let out = '';
  let at = 0;
  for (const t of tokens) {
    out += text.slice(at, t.index);
    let value = '';
    if (t.kind === 'contact') value = values.contacto?.[t.key];
    else if (t.kind === 'base') value = values.base?.[t.key];
    value = value === null || value === undefined ? '' : String(value);
    out += value.trim() ? value : (t.fallback ?? '');
    at = t.index + t.raw.length;
  }
  return (out + text.slice(at)).replace(/[ \t]{2,}/g, ' ');
}

// Decide qué reglas coinciden con un texto, en el orden de la lista. Sólo lectura. `record` es lo que leen las
// condiciones ({channel, course, hours, tags, first_message}); `limitOk(rule)` dice si «una vez» o el descanso la
// dejan correr. Devuelve todas las reglas con su veredicto (para explicar) y las que coinciden.
export function matchRules(rules, text, record, { limitOk = () => true, now = Date.now() } = {}) {
  const verdicts = [];
  let stopped = null;
  for (const rule of rules) {
    const def = rule.definition;
    if (stopped) {
      verdicts.push({ rule, matched: false, reason: `No se revisa: «${stopped}» pide no seguir con las de abajo.` });
      continue;
    }
    if (!def?.trigger) {
      verdicts.push({ rule, matched: false, reason: 'La regla no se puede leer.' });
      continue;
    }
    const hit = triggerMatch(def.trigger, text);
    if (!hit) {
      verdicts.push({ rule, matched: false, reason: 'Ninguna palabra clave coincide.' });
      continue;
    }
    let pass = true;
    if (def.conditions) {
      try {
        pass = matcher(def.conditions, FIELDS)(record, now);
      } catch {
        pass = false;
      }
    }
    if (!pass) {
      verdicts.push({ rule, matched: false, hit, reason: 'Coincide la palabra, pero no se cumplen sus condiciones.' });
      continue;
    }
    if (!limitOk(rule)) {
      const why =
        def.options.limit === 'once_conversation'
          ? 'Ya corrió una vez en esta conversación.'
          : 'Está en su descanso: corrió hace poco en esta conversación.';
      verdicts.push({ rule, matched: false, hit, reason: why });
      continue;
    }
    verdicts.push({
      rule,
      matched: true,
      hit,
      reason: hit.word ? `Coincide con «${hit.word}».` : 'Cualquier mensaje.',
    });
    if (def.options.stop) stopped = rule.title;
  }
  return { verdicts, matched: verdicts.filter(v => v.matched) };
}

export function createRunner({ host, repo, now = () => Date.now() }) {
  const { db } = host;
  const svc = host.services;
  const optional = name => {
    try {
      return host.module(name);
    } catch {
      return null;
    }
  };
  const automatable = c => Boolean(c && c.bot_enabled && !c.assigned_to && c.status === 'open');
  const brandSpeaks = brandId =>
    svc.automation.enabledFor(brandId) && SPEAKS.includes(svc.replies.settings(brandId).mode);

  function savepoint(name, fn) {
    db.exec('SAVEPOINT ' + name);
    try {
      const out = fn();
      db.exec('RELEASE ' + name);
      return { ok: true, out };
    } catch (error) {
      db.exec('ROLLBACK TO ' + name);
      db.exec('RELEASE ' + name);
      return { ok: false, error };
    }
  }

  // ¿Puede correr otra vez en esta conversación? («una vez» y el descanso cuentan sólo las veces que hizo algo)
  const limitFor = (brandId, conversationId) => rule => {
    const o = rule.definition.options;
    if (o.limit === 'always' || !conversationId) return true;
    const last = repo.lastExecuted(brandId, rule.id, conversationId);
    if (last === null) return true;
    if (o.limit === 'once_conversation') return false;
    return last + o.cooldownMinutes * 60_000 <= now();
  };

  // Lo que leen las condiciones, de una conversación real.
  function recordOf(brandId, c, contactId) {
    const policy = svc.operations.settings(brandId);
    return {
      channel: c.channel,
      course: c.course_id,
      hours: isOpen(now(), policy) ? 'open' : 'closed',
      tags: repo.contactTags(brandId, contactId),
      first_message: repo.customerMessages(brandId, c.id) === 1,
    };
  }

  // Valores de {{…}}: los mismos que usan los recorridos (catálogo vigente y la persona) más {{contacto.clave}}.
  function valuesFor(brandId, c, contactId, name) {
    const first = String(name || '').split(' ')[0] || '';
    let base = { nombre: first, nombre_completo: name || '' };
    try {
      const info = svc.catalogue.info(c.course_id, c.edition_id);
      const regular = info.edition.price_cents;
      const tv = templateValues(info, first);
      base = {
        ...tv,
        nombre: first,
        nombre_completo: name || '',
        vigencia_corta: info.promotion ? tv.vigencia : '',
        ahorro: regular > info.priceCents ? ((regular - info.priceCents) / 100).toFixed(2) + ' ' + info.currency : '',
      };
    } catch {
      /* sin catálogo vigente: sólo los datos de la persona */
    }
    let contacto = {};
    const attributes = optional('attributes');
    if (contactId && attributes) {
      try {
        contacto = attributes.variableValues(brandId, contactId).contacto || {};
      } catch {
        contacto = {};
      }
    }
    return { base, contacto };
  }

  // Por qué no puede salir un MENSAJE ahora (null si puede). Las acciones silenciosas y el pase a una persona no lo
  // necesitan. Se calcula una vez por mensaje.
  function messageBlock(brandId, c, contactId, settings) {
    const w = svc.channel.windowOf(c);
    if (w.enforced && !w.open) return 'window_closed';
    if (repo.optedOut(brandId, contactId)) return 'opted_out';
    if (c.wa_number) {
      const verdict = svc.whatsapp?.canSendFrom?.(c.wa_number, { to: c.wa_peer || null });
      if (verdict && !verdict.ok) return 'listen_only';
    }
    if (repo.consecutiveRuleReplies(brandId, c.id, settings.maxConsecutive) >= settings.maxConsecutive)
      return 'consecutive_cap';
    return null;
  }

  // ---- acciones (dentro del SAVEPOINT de la regla). Cada una devuelve {outcome: 'done'|'skipped', reason?, sent?}
  function send(x, body, prepared = null) {
    const ref = `rule:${x.rule.id}:${x.m.id}:${x.n++}`;
    if (repo.messageByRef(ref)) return { outcome: 'skipped', reason: 'duplicate' };
    const c = repo.conversation(x.brandId, x.c.id);
    const id = host.insertMessage(
      c,
      null,
      body,
      'automation',
      ref,
      null,
      prepared?.flyerSnapshot ? c.course_id : null,
      prepared,
      { category: 'service' },
    );
    x.sent.push({ id, text: body });
    return { outcome: 'done' };
  }
  const EXEC = {
    add_tag(a, x) {
      if (!x.contactId) return { outcome: 'skipped', reason: 'no_contact' };
      const r = savepoint('rules_tag', () => svc.contacts.addTag(x.contactId, a.tagId));
      if (!r.ok) return { outcome: 'skipped', reason: 'tag_unavailable' };
      return r.out ? { outcome: 'done' } : { outcome: 'skipped', reason: 'already_tagged' };
    },
    remove_tag(a, x) {
      if (!x.contactId) return { outcome: 'skipped', reason: 'no_contact' };
      return svc.contacts.removeTag(x.contactId, a.tagId)
        ? { outcome: 'done' }
        : { outcome: 'skipped', reason: 'not_tagged' };
    },
    send_text(a, x) {
      return send(x, forBrand(db, x.brandId, renderText(a.text, x.values())));
    },
    send_material(a, x) {
      const c = repo.conversation(x.brandId, x.c.id);
      if (c.course_pending) return { outcome: 'skipped', reason: 'course_unknown' };
      let prepared;
      try {
        prepared = svc.catalogue.prepare(c, { templateId: a.materialId });
      } catch (error) {
        if (error?.status === 409 || error?.status === 404)
          return { outcome: 'skipped', reason: 'material_unavailable' };
        throw error;
      }
      return send(x, prepared.text, prepared);
    },
    start_flow(a, x) {
      const flows = optional('chatflows');
      const target = flows?.repo.published(x.brandId, a.flowId);
      if (!target || target.status !== 'active') return { outcome: 'skipped', reason: 'flow_unavailable' };
      if (flows.repo.activeSession(x.brandId, x.c.id)) return { outcome: 'skipped', reason: 'flow_active' };
      const c = repo.conversation(x.brandId, x.c.id);
      const ctx = flows.runtime.start(c, target, {
        startedBy: 'rule',
        sourceKey: 'rule:' + x.rule.id + ':' + x.m.id,
        trigger: x.m,
      });
      if (ctx.s.state === 'ended' && !ctx.sent.length && !ctx.handedOff)
        return { outcome: 'skipped', reason: 'flow_silent' };
      // Este mensaje ya inició la sesión: el recorrido no lo vuelve a tomar como respuesta (igual que al arrancar solo).
      ctx.s.lastInputMessageId = x.m.id;
      flows.repo.saveSession(x.brandId, ctx.s, ctx.s.seq, now());
      x.sent.push(...ctx.sent);
      x.flow = { id: target.id, version: target.version };
      if (ctx.handedOff) x.escalated = true;
      return { outcome: 'done' };
    },
    handoff(a, x) {
      if (a.text) {
        if (x.block) x.notes.push({ type: 'handoff', outcome: 'skipped', reason: x.block, part: 'text' });
        else send(x, forBrand(db, x.brandId, renderText(a.text, x.values())));
      }
      const c = repo.conversation(x.brandId, x.c.id);
      if (c.bot_enabled && !c.assigned_to) svc.replies.escalate(c, x.m);
      x.escalated = true;
      if (a.to === 'user') {
        const r = savepoint('rules_assign', () =>
          svc.operations.assign(repo.conversation(x.brandId, c.id), a.userId, null, 'Regla: ' + x.rule.title),
        );
        if (!r.ok) return { outcome: 'done', reason: 'assign_failed' };
      }
      return { outcome: 'done' };
    },
    set_status(a, x) {
      const c = repo.conversation(x.brandId, x.c.id);
      const lifecycle = optional('lifecycle');
      if (a.status === 'pending') {
        if (!lifecycle) return { outcome: 'skipped', reason: 'status_unavailable' };
        const r = savepoint('rules_status', () => lifecycle.pend(c, null));
        return r.ok ? { outcome: 'done' } : { outcome: 'skipped', reason: 'status_unavailable' };
      }
      // Resuelta: los mismos efectos que «Resolver» desde el chat (sin enviar nada a la persona).
      if (lifecycle) lifecycle.resolve(c, null, { by: 'automation', reason: 'rule' });
      else repo.resolve(x.brandId, c.id, now());
      svc.operations.reset(c, 'resolved', null);
      repo.cancelJobs(x.brandId, c.id);
      cancelConversationSteps(db, c.id, 'conversation_action');
      x.resolved = true;
      return { outcome: 'done' };
    },
  };

  // Corre una regla que coincidió. Devuelve {results, voice}. Dentro de su SAVEPOINT (lo pone quien llama).
  function execute(rule, x) {
    const results = [];
    let voice = false;
    for (const a of ordered(rule.definition.actions)) {
      const kind = kindOf(a);
      if (kind !== 'silent' && x.voiceTaken) {
        results.push({ type: a.type, outcome: 'skipped', reason: 'voice_taken' });
        continue;
      }
      const sendsMessage = kind === 'voice';
      if (sendsMessage && x.block) {
        results.push({ type: a.type, outcome: 'skipped', reason: x.block });
        continue;
      }
      x.notes = [];
      const out = EXEC[a.type](a, x);
      results.push({ type: a.type, outcome: out.outcome, ...(out.reason ? { reason: out.reason } : {}) });
      results.push(...x.notes);
      if (out.outcome === 'done' && kind !== 'silent') voice = true;
    }
    return { results, voice };
  }

  // ---- el despachador: la persona escribió (dentro de la transacción del trabajo del asistente)
  function inbound(c, m) {
    const brandId = c.brand_id;
    if (!repo.hasActive(brandId)) return null; // sin reglas activas: nada cambia
    if (!automatable(c) || !brandSpeaks(brandId)) return null;
    if (svc.contacts.isOptOutText(m.text)) return null; // la baja la atiende el asistente (prioridad 1)
    // Un recorrido en curso va antes que las reglas: se le cede el turno. Si su espera ya venció, termina aquí igual
    // que lo terminaría el recorrido («timeout») y las reglas van antes que un recorrido que arranca.
    const flows = optional('chatflows');
    const row = flows?.repo.activeSession(brandId, c.id);
    if (row) {
      const expired = row.expires_at !== null && row.expires_at <= now() && row.last_input_message_id !== m.id;
      if (!expired) return null;
      flows.runtime.endRow(brandId, row, 'timeout');
    }
    const rules = repo.active(brandId);
    const contactId = repo.contactId(brandId, c.id);
    const record = recordOf(brandId, c, contactId);
    const { matched } = matchRules(rules, m.text || '', record, { limitOk: limitFor(brandId, c.id), now: now() });
    if (!matched.length) return null;
    const settings = repo.settings(brandId);
    const block = messageBlock(brandId, c, contactId, settings);
    let values = null;
    const name = repo.customerName(brandId, c.id);
    const sourceKey = 'msg:' + m.id;
    let spoke = null;
    for (const { rule } of matched) {
      if (repo.runExists(rule.id, sourceKey)) continue; // el mismo mensaje ya pasó por esta regla (trabajo repetido)
      const x = {
        brandId,
        c,
        m,
        rule,
        contactId,
        block,
        voiceTaken: Boolean(spoke),
        sent: [],
        notes: [],
        n: 0,
        escalated: false,
        resolved: false,
        flow: null,
        values: () => (values ??= valuesFor(brandId, repo.conversation(brandId, c.id), contactId, name)),
      };
      const r = savepoint('rules_rule', () => execute(rule, x));
      const at = now();
      if (!r.ok) {
        // Lo de esta regla se deshizo entero; queda anotada y siguen las demás.
        const detail = String(r.error?.message || r.error).slice(0, 200);
        repo.insertRun(brandId, {
          id: randomUUID(),
          ruleId: rule.id,
          revision: rule.revision,
          conversationId: c.id,
          sourceKey,
          outcome: 'failed',
          voice: false,
          actions: [],
          reason: detail,
          at,
        });
        repo.failed(brandId, rule.id, detail, at);
        repo.adminNotice(brandId, 'rule_error', { conversationId: c.id, ruleId: rule.id, error: detail }, at);
        console.error('Rule failed', r.error?.name, detail.slice(0, 120));
        continue;
      }
      const { results, voice } = r.out;
      const done = results.filter(a => a.outcome === 'done').length;
      const outcome = !done ? 'skipped' : results.some(a => a.outcome === 'skipped') ? 'partial' : 'executed';
      repo.insertRun(brandId, {
        id: randomUUID(),
        ruleId: rule.id,
        revision: rule.revision,
        conversationId: c.id,
        sourceKey,
        outcome,
        voice,
        actions: results,
        reason: null,
        at,
      });
      if (done) repo.fired(brandId, rule.id, at);
      if (voice && !spoke) spoke = { rule, x };
    }
    if (!spoke) return null;
    const { rule, x } = spoke;
    if (!repo.replyLogged(brandId, m.id)) {
      const first = x.sent[0] || null;
      repo.replyLog(brandId, {
        id: randomUUID(),
        conversationId: c.id,
        triggerId: m.id,
        replyId: first?.id ?? null,
        mode: svc.replies.settings(brandId).mode,
        action: x.escalated ? 'escalated' : first ? 'replied' : 'skipped',
        text: first?.text ?? '',
        sources: [
          { type: 'rule', id: rule.id, revision: rule.revision },
          ...(x.flow ? [{ type: 'flow', id: x.flow.id, version: x.flow.version }] : []),
        ],
        reason: 'Regla «' + rule.title + '» (revisión ' + rule.revision + ').',
        at: now(),
      });
    }
    return { done: true };
  }

  // ---- «Probar»: la misma decisión, sin escribir ni enviar nada. `sample` describe el mensaje: {text, channel,
  // courseId, firstMessage, tags, hours} o una conversación real ({conversation}). `override` reemplaza (o añade
  // arriba) una regla con su definición sin guardar, como si estuviera activa.
  function explain(brandId, sample, { override = null } = {}) {
    const pipeline = [];
    const text = String(sample.text ?? '');
    const c = sample.conversation || null;
    const auto = svc.automation.enabledFor(brandId);
    const mode = svc.replies.settings(brandId).mode;
    const speaks = auto && SPEAKS.includes(mode);
    let answeredBy = null;
    const step = (key, label, result, detail) => pipeline.push({ step: key, label, result, detail });
    if (c && !automatable(c)) {
      step('person', 'Una persona atiende la conversación', 'answers', 'Nada automático contesta este mensaje.');
      answeredBy = 'person';
    } else step('person', 'Una persona atiende la conversación', 'pass', 'Nadie del equipo tiene esta conversación.');
    if (!answeredBy && !speaks) {
      step(
        'automation',
        'Automatización de la marca',
        'answers',
        !auto
          ? 'La automatización de la marca está apagada: no corren reglas ni recorridos.'
          : 'El asistente de la marca no responde solo: no corren reglas ni recorridos.',
      );
      answeredBy = 'assistant';
    }
    if (!answeredBy && svc.contacts.isOptOutText(text)) {
      step('opt_out', 'La persona pide la baja', 'answers', 'El asistente registra la baja y la confirma una vez.');
      answeredBy = 'assistant';
    }
    const flows = optional('chatflows');
    if (!answeredBy && c) {
      const row = flows?.repo.activeSession(brandId, c.id);
      const expired = row && row.expires_at !== null && row.expires_at <= now();
      if (row && !expired) {
        step('flow_in_progress', 'Recorrido en curso', 'answers', 'El recorrido en curso toma el mensaje.');
        answeredBy = 'flow_in_progress';
      } else step('flow_in_progress', 'Recorrido en curso', 'pass', 'No hay un recorrido esperando respuesta.');
    } else if (!answeredBy)
      step('flow_in_progress', 'Recorrido en curso', 'pass', 'Mensaje de ejemplo: sin recorrido en curso.');
    // Reglas
    let rules = repo.active(brandId);
    if (override) {
      const draft = { ...override, status: 'active' };
      const at = rules.findIndex(r => r.id === override.id);
      if (at >= 0) rules[at] = { ...rules[at], ...draft };
      else {
        const all = repo.rules(brandId);
        const pos = all.find(r => r.id === override.id)?.position;
        rules = pos === undefined ? [draft, ...rules] : [...rules, draft].sort((a, b) => a.position - b.position);
      }
    }
    let record;
    let limitOk = () => true;
    let contactId = null;
    if (c) {
      contactId = repo.contactId(brandId, c.id);
      record = recordOf(brandId, c, contactId);
      // el mensaje de prueba sería uno más de la persona
      record.first_message = repo.customerMessages(brandId, c.id) === 0;
      limitOk = limitFor(brandId, c.id);
    } else {
      const policy = svc.operations.settings(brandId);
      record = {
        channel: sample.channel || 'whatsapp',
        course: sample.courseId || null,
        hours:
          sample.hours === 'open' || sample.hours === 'closed'
            ? sample.hours
            : isOpen(now(), policy)
              ? 'open'
              : 'closed',
        tags: Array.isArray(sample.tags) ? sample.tags.map(String) : [],
        first_message: sample.firstMessage === true,
      };
    }
    const { verdicts, matched } = matchRules(rules, text, record, { limitOk, now: now() });
    const settings = repo.settings(brandId);
    const block = c ? messageBlock(brandId, c, contactId, settings) : null;
    let voice = null;
    const report = verdicts.map(v => {
      const def = v.rule.definition;
      const actions =
        v.matched && !answeredBy
          ? ordered(def.actions).map(a => {
              const kind = kindOf(a);
              let would = true;
              let reason = null;
              if (kind !== 'silent' && voice && voice !== v.rule.id) [would, reason] = [false, REASONS.voice_taken];
              else if (kind === 'voice' && block) [would, reason] = [false, REASONS[block]];
              const preview =
                a.type === 'send_text' || (a.type === 'handoff' && a.text)
                  ? renderText(
                      a.text,
                      c
                        ? valuesFor(brandId, c, contactId, repo.customerName(brandId, c.id))
                        : sampleValues(brandId, record),
                    )
                  : null;
              return { type: a.type, label: ACTIONS[a.type]?.label ?? a.type, kind, would, reason, preview };
            })
          : [];
      if (!answeredBy && v.matched && !voice && actions.some(a => a.kind !== 'silent' && a.would)) voice = v.rule.id;
      return {
        ruleId: v.rule.id,
        title: v.rule.title,
        draft: Boolean(override && v.rule.id === override.id),
        matched: v.matched && !answeredBy,
        reason:
          answeredBy && v.matched
            ? `Coincidiría (${v.reason.replace(/\.$/, '')}), pero antes en el orden atiende otro.`
            : v.reason,
        voice: voice === v.rule.id,
        actions,
      };
    });
    if (!answeredBy) {
      if (voice) {
        const r = report.find(x => x.ruleId === voice);
        step('rules', 'Reglas por mensaje', 'answers', `Responde la regla «${r.title}».`);
        answeredBy = 'rule';
      } else
        step(
          'rules',
          'Reglas por mensaje',
          'pass',
          matched.length
            ? 'Coinciden reglas sin respuesta: corren sus acciones silenciosas y sigue el orden.'
            : rules.length
              ? 'Ninguna regla activa coincide.'
              : 'La marca no tiene reglas activas.',
        );
    }
    if (!answeredBy) {
      const first = record.first_message;
      const starting = repo
        .activeFlows(brandId)
        .find(
          f =>
            (f.start.type === 'keyword' &&
              keywordMatch(text, f.start.keywords || [], { mode: f.start.mode || 'contains' }) !== null) ||
            (f.start.type === 'first_message' && first) ||
            f.start.type === 'any_message',
        );
      if (starting) {
        step('flow_start', 'Recorrido que arranca', 'answers', `Arrancaría el recorrido «${starting.name}».`);
        answeredBy = 'flow_start';
      } else
        step('flow_start', 'Recorrido que arranca', 'pass', 'Ningún recorrido publicado arranca con este mensaje.');
    }
    if (!answeredBy) {
      step('assistant', 'Asistente de la marca', 'answers', 'Contesta el asistente de siempre.');
      answeredBy = 'assistant';
    }
    return { pipeline, rules: report, answeredBy, sent: false };
  }

  // Valores de muestra para «Probar» sin conversación: el catálogo del curso elegido y «Ana» como nombre.
  function sampleValues(brandId, record) {
    try {
      if (!record.course) throw new Error('sin curso');
      const info = svc.catalogue.info(record.course, null);
      return { base: { ...templateValues(info, 'Ana'), nombre: 'Ana', nombre_completo: 'Ana Ejemplo' }, contacto: {} };
    } catch {
      return { base: { nombre: 'Ana', nombre_completo: 'Ana Ejemplo' }, contacto: {} };
    }
  }

  return { inbound, explain, brandSpeaks, automatable };
}
