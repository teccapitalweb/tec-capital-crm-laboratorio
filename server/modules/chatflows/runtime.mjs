// Sesiones de los recorridos sobre la base de datos (docs/PLAN_RECORRIDOS.md; diseño de automatización §3 y §6.3).
//
// Une el motor puro (engine.mjs) con el resto del servidor:
//   - inbound(c, m): lo llama el despachador (server/app/dispatch.mjs) dentro de la transacción del trabajo del
//     asistente cuando la persona escribe: un recorrido en curso consume el mensaje, o uno publicado arranca.
//   - el paso durable «flow.wake» (cola de automatización, server/automation.mjs): esperas, tiempo límite de una
//     pregunta y recordatorio. Sobrevive a un reinicio (vive en automation_steps con arrendamiento) y no se ejecuta dos
//     veces (clave `flow:<sesión>:<seq>:<tipo>` y comprobación del `seq` de la sesión antes del efecto).
//   - el gancho de cancelación: cuando una persona del equipo toma, asigna o cierra la conversación (todo pasa por
//     cancelConversationSteps), la sesión termina y el recorrido no vuelve a hablar.
//
// Reglas de seguridad: sólo atiende con la automatización de la marca encendida y su asistente respondiendo solo
// («Plantillas» o «Autónomo»); nada de red dentro de la transacción; todo mensaje sale por insertMessage (la misma
// puerta de salida del asistente: ventana de 24 horas, modo escucha del número, `forBrand`); nunca confirma un pago.
import { randomUUID } from 'node:crypto';
import { keywordMatch } from '../../lib/conditions.mjs';
import { forBrand } from '../../lib/real-mode.mjs';
import { isOpen } from '../../service-hours.mjs';
import { templateValues } from '../../catalogue.mjs';
import * as copy from '../../reply-copy.mjs';
import { candidates } from '../../course-match.mjs';
import { FLOW_FILE_MIMES } from '../../../public/kit/shared/flow-support.js';
import { advance, input, makeEnv, newSession, numberedOptions, rememberChoice, route } from './engine.mjs';

const SPEAKS = ['templates', 'autonomous'];
const MAX_DEPTH = 5;
const MAX_TEMPLATES_PER_SESSION = 3; // plantillas de WhatsApp que una misma atención de un recorrido puede enviar
const COPY = Object.freeze({
  ...copy,
  invalidAnswer: 'No logré entender tu respuesta. ¿Me la escribes de nuevo, por favor?',
});

// Día de la semana (0 = domingo) y minutos del día en una zona horaria.
function clockIn(t, zone) {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(new Date(t))
        .map(p => [p.type, p.value]),
    );
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    return { day, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  } catch {
    return null;
  }
}

const fromRow = row => ({
  id: row.id,
  flowId: row.flow_id,
  version: row.flow_version,
  conversationId: row.conversation_id,
  state: row.state,
  nodeId: row.node_id,
  seq: row.seq,
  vars: row.vars || {},
  waiting: row.waiting,
  steps: row.steps,
  unanswered: row.unanswered,
  expiresAt: row.expires_at,
  outcome: row.outcome,
  endNodeId: row.end_node_id,
  lastInputMessageId: row.last_input_message_id,
  startedAt: row.started_at,
});

export function createRuntime({ host, repo, now = () => Date.now(), emit = () => {} }) {
  const { db } = host;
  const svc = host.services;
  const attributes = () => host.module('attributes');
  const lifecycle = () => {
    try {
      return host.module('lifecycle');
    } catch {
      return null;
    }
  };
  const automatable = c => c && c.bot_enabled && !c.assigned_to && c.status === 'open';
  const brandSpeaks = brandId =>
    svc.automation.enabledFor(brandId) && SPEAKS.includes(svc.replies.settings(brandId).mode);

  // Corre `fn` en un SAVEPOINT: si lanza, se deshace sólo lo suyo.
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

  // ---- la puerta de salida real del motor
  function realIo(ctx) {
    const { brandId, s } = ctx;
    const conv = () => repo.conversation(brandId, ctx.c.id);
    let values = null;
    let contactId;
    const contact = () => (contactId === undefined ? (contactId = repo.contactId(brandId, ctx.c.id)) : contactId);
    const catalogueCard = kind => {
      const c = conv();
      if (c.course_pending) return { reason: 'Todavía no sabemos qué curso le interesa' };
      const info = svc.catalogue.info(c.course_id, c.edition_id);
      if (info.reason) return { reason: info.reason };
      try {
        return { ctx: info, prepared: svc.catalogue.prepare(c, { kind }) };
      } catch (error) {
        if (error?.status === 409) return { reason: String(error.message).replace(/\.$/, '') };
        throw error;
      }
    };
    return {
      copy: COPY,
      values() {
        if (values) return values;
        const c = conv();
        const name = repo.customerName(brandId, c.id);
        const first = name.split(' ')[0] || '';
        let base = { nombre: first, nombre_completo: name };
        try {
          const info = svc.catalogue.info(c.course_id, c.edition_id);
          const regular = info.edition.price_cents;
          base = {
            ...templateValues(info, first),
            nombre: first,
            nombre_completo: name,
            vigencia_corta: info.promotion ? templateValues(info, first).vigencia : '',
            ahorro:
              regular > info.priceCents ? ((regular - info.priceCents) / 100).toFixed(2) + ' ' + info.currency : '',
          };
        } catch {
          /* sin catálogo vigente: sólo los datos de la persona */
        }
        let contacto = {};
        const id = contact();
        if (id) contacto = attributes().variableValues(brandId, id).contacto;
        return (values = { base, contacto });
      },
      conditionRecord() {
        const c = conv();
        const id = contact();
        const attr = id ? attributes().record(brandId, id).attr : {};
        const policy = svc.operations.settings(brandId);
        return {
          attr,
          tags: attr.etiquetas || [],
          course: c.course_id,
          channel: c.channel,
          open: isOpen(now(), policy),
          clock: clockIn(now(), policy.timezone),
        };
      },
      // Todo sale por insertMessage (ventana, modo escucha, entrega). Un archivo viaja como la ficha del curso: en
      // `flyer_snapshot` con `libraryFileId` (lo entienden el chat, la descarga con alcance por conversación y la
      // salida a Meta); una lista guarda además `interactive` para WhatsApp real y su texto numerado para lo demás.
      send({ text, buttons = null, prepared = null, order = false, list = null, file = null, template = null }) {
        const c = conv();
        const prefix = `flow:${s.id}:${s.seq}:`;
        const ref = prefix + repo.refsWithPrefix(prefix);
        if (template) {
          // Igual que la manda el equipo desde el chat (wa-templates.forConversation): su texto ya resuelto, su
          // categoría de costo y su definición para Meta. Una plantilla sale aunque la ventana esté cerrada.
          const id = host.insertMessage(c, null, template.text, 'automation', ref, null, null, null, {
            category: template.category,
            template: template.template,
            buttons: template.buttons?.length ? template.buttons : undefined,
            keepButtons: Boolean(template.buttons?.length),
          });
          ctx.sent.push({ id, text: template.text });
          return id;
        }
        let body = text;
        if (order) {
          const made = svc.payments.createOrder(c, { user: null, source: 'bot' });
          body = body.replace('{{pedido}}', svc.payments.linkMessage(made.order));
        }
        if (list) body = body + '\n\n' + numberedOptions(list.options);
        body = forBrand(db, brandId, body); // modo real: sin avisos de prueba (docs/PLAN_MODO_REAL.md)
        const id = host.insertMessage(
          c,
          null,
          body,
          'automation',
          ref,
          null,
          prepared?.flyerSnapshot || file ? c.course_id : null,
          file ? null : prepared || null,
          { buttons: buttons || undefined, keepButtons: Boolean(buttons), category: 'service' },
        );
        if (file) repo.attachFile(id, { libraryFileId: file.id, file: true });
        if (list)
          repo.setInteractive(id, {
            type: 'list',
            header: list.header,
            body: forBrand(db, brandId, list.body),
            footer: list.footer,
            button: list.button,
            sections: list.sections,
          });
        ctx.sent.push({ id, text: body });
        return id;
      },
      // Un archivo de la biblioteca de ESTA marca y de un tipo que el recorrido puede enviar; si no, el motivo.
      file(fileId) {
        const f = repo.libraryFile(brandId, String(fileId || ''));
        if (!f) return { reason: 'El archivo ya no está en la biblioteca de la marca' };
        if (!FLOW_FILE_MIMES.includes(f.mime)) return { reason: 'El archivo no es una imagen JPG o PNG ni un PDF' };
        return { id: f.id, name: f.filename, mime: f.mime };
      },
      // Una plantilla de WhatsApp para esta conversación, con las mismas reglas que el envío desde el chat.
      template(templateId) {
        const c = conv();
        if (!c.wa_number)
          return {
            reason: 'Las plantillas de WhatsApp sólo salen por un número real; esta conversación es del laboratorio',
          };
        const verdict = svc.whatsapp?.canSendFrom?.(c.wa_number, { to: c.wa_peer || null });
        if (verdict && !verdict.ok) return { reason: verdict.message || 'El número está en modo escucha' };
        let api = null;
        try {
          api = host.module('wa-templates');
        } catch {
          api = null;
        }
        if (!api?.forConversation) return { reason: 'Las plantillas de WhatsApp no están disponibles en este momento' };
        const tpl = api.forConversation(c, String(templateId || ''));
        if (tpl.reason) return tpl;
        // Una plantilla es lo único que sale con la ventana cerrada, y cuesta: en una misma atención cada plantilla
        // sale una sola vez y hay un tope, aunque el recorrido vuelva al mismo paso (por ejemplo, por «no contestó»).
        const sent = repo.templatesOfSession(s.id);
        if (sent.includes(tpl.template.templateId))
          return { reason: 'Esa plantilla ya se envió en este recorrido a esta persona' };
        if (sent.length >= MAX_TEMPLATES_PER_SESSION)
          return { reason: 'El recorrido ya envió el máximo de plantillas a esta persona' };
        // Marketing con la ventana cerrada es un mensaje que inicia el negocio: sólo a quien aceptó recibirlo, la
        // misma regla que las difusiones y las secuencias. Con la ventana abierta la persona acaba de escribir.
        if (tpl.category === 'marketing' && !this.windowOpen() && repo.consentOf(brandId, contact()) !== 'opted_in')
          return { reason: 'La persona no ha aceptado recibir promociones y la ventana de 24 horas está cerrada' };
        return tpl;
      },
      windowOpen() {
        const w = svc.channel.windowOf(conv());
        return !(w.enforced && !w.open);
      },
      stop() {
        const c = conv();
        if (!c || !c.bot_enabled || c.assigned_to) return 'human_takeover';
        if (c.status !== 'open') return 'closed';
        if (!brandSpeaks(brandId)) return 'automation_off';
        if (repo.optedOut(brandId, contact())) return 'opt_out';
        return null;
      },
      catalogue: catalogueCard,
      material(templateId) {
        const c = conv();
        try {
          const prepared = svc.catalogue.prepare(c, { templateId });
          return { text: prepared.text, prepared };
        } catch (error) {
          if (error?.status === 409 || error?.status === 404)
            return { reason: String(error.message).replace(/\.$/, '') };
          throw error;
        }
      },
      enroll() {
        const card = catalogueCard('flyer');
        if (card.reason) return { reason: card.reason };
        const c = conv();
        const name = repo.customerName(brandId, c.id);
        const open = svc.payments.openOrder(c.id);
        if (open)
          return { kind: 'reminder', text: copy.orderReminder(open.reference) + svc.payments.linkMessage(open) };
        if (svc.payments.settings(brandId).enabled)
          return { kind: 'order', text: copy.enrollWithOrder(card.ctx, name) };
        return { kind: 'manual', text: copy.enrollWithAdvisor(card.ctx, name) };
      },
      stage(stage) {
        svc.crm.setStage(conv(), stage);
      },
      setAttribute(key, value) {
        const id = contact();
        if (!id) return ctx.log('error', { nodeId: s.nodeId, detail: 'Sin contacto: no se guardó ' + key });
        const r = savepoint('chatflow_attr', () =>
          attributes().set(brandId, id, [{ key, value }], {
            source: 'flow',
            sourceId: s.id,
            conversationId: ctx.c.id,
          }),
        );
        if (!r.ok) ctx.log('error', { nodeId: s.nodeId, detail: 'No se guardó ' + key + ': ' + r.error?.message });
        values = null;
      },
      tags(add, remove) {
        const id = contact();
        if (!id) return;
        for (const tag of add) {
          const r = savepoint('chatflow_tag', () => svc.contacts.addTag(id, tag));
          if (!r.ok) ctx.log('error', { nodeId: s.nodeId, detail: 'Etiqueta: ' + r.error?.message });
        }
        for (const tag of remove) svc.contacts.removeTag(id, tag);
      },
      // Inscribir en una secuencia por la puerta que da el módulo de secuencias (enrollInTx), dentro de ESTA
      // transacción: sus mismas reglas (marca, curso, baja, ya inscrita o pagada, secuencia apagada). La referencia
      // es la sesión y el paso: un reintento, o volver a este paso en la misma sesión, no inscribe dos veces.
      // → {enrolled, duplicate} | {refused: motivo}. Nunca lanza: lo que falle queda anotado y el recorrido sigue.
      sequence(sequenceId, nodeId) {
        let api = null;
        try {
          api = host.module('sequences');
        } catch {
          api = null;
        }
        if (!api?.enrollInTx) return { refused: 'unavailable' };
        const r = savepoint('chatflow_sequence', () =>
          api.enrollInTx(conv(), String(sequenceId || ''), { source: 'flow', clientRef: `flow:${s.id}:${nodeId}` }),
        );
        if (!r.ok) {
          ctx.log('error', { nodeId, detail: 'No se inscribió en la secuencia: ' + r.error?.message });
          return { refused: 'error' };
        }
        if (r.out?.refused) return { refused: r.out.refused };
        return { enrolled: true, duplicate: Boolean(r.out?.duplicate) };
      },
      // «¿Qué curso te interesa?»: la lista, la lectura de la respuesta y la regla de cambio son las del asistente
      // (server/replies.mjs); el cambio, el de siempre (crm.moveConversation: nunca a un curso de otra marca, el
      // interés de relleno pasa al curso elegido). Después de mover, todo lo que sigue lee la conversación de nuevo.
      courses() {
        const c = conv();
        return { list: svc.replies.courseList(brandId), known: !c.course_pending };
      },
      courseFrom(text, opts) {
        if (!String(text || '').trim()) return null;
        return svc.replies.pickCourse(svc.replies.courseList(brandId), text, opts) || null;
      },
      // Los cursos que comparten lo que nombró el texto («reptiles», «perros y gatos»), con la misma regla que el
      // asistente (course-match: candidates). Vacío si no acota o si serían demasiados para una lista corta.
      courseCandidates(text, { strict = false } = {}) {
        if (!String(text || '').trim()) return [];
        return candidates(svc.replies.courseList(brandId), text, { strict });
      },
      // ¿El negocio ya le habló en esta atención? Lo que este recorrido ya dijo en este turno o, en la base, un
      // mensaje del asistente, de un recorrido o del equipo desde que se abrió el ciclo de atención (o, sin ciclo,
      // desde que empezó esta sesión). Así «¿Qué curso te interesa?» no repite el saludo.
      spoke() {
        if (ctx.sent.length) return true;
        const c = conv();
        const cycle = c.cycle_id
          ? db.prepare('SELECT opened_at FROM conversation_cycles WHERE id=?').get(c.cycle_id)
          : null;
        const since = Math.min(cycle?.opened_at ?? Infinity, s.startedAt ?? Infinity);
        if (!Number.isFinite(since)) return false;
        return Boolean(
          db
            .prepare(
              "SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind IN ('agent','automation') AND created_at>=? LIMIT 1",
            )
            .get(c.id, since),
        );
      },
      startText() {
        if (ctx.startText === undefined) ctx.startText = repo.startMessageText(brandId, s.id);
        return ctx.startText;
      },
      chooseCourse(course) {
        const c = conv();
        const verdict = svc.replies.courseSwitch(c, course);
        if (verdict === 'blocked')
          return { blocked: { current: repo.courseTitle(brandId, c.course_id), other: course.title } };
        if (verdict === 'taken') return { refused: 'taken' };
        // «same» también pasa por aquí: si era el curso de relleno, deja de serlo; si ya era el suyo, no cambia nada.
        const target = verdict === 'same' ? { id: c.course_id, editionId: c.edition_id } : course;
        if (!svc.crm.moveConversation(c, target.id, target.editionId, { placeholder: Boolean(c.course_pending) }))
          return { refused: 'taken' };
        values = null;
        return { ok: true, moved: verdict !== 'same' };
      },
      brandName: () => repo.brandName(brandId),
      lastMessageText: () => repo.lastCustomerMessage(brandId, ctx.c.id)?.text || '',
      schedule(kind, at) {
        svc.automation.enqueueInTx({
          brandId,
          conversationId: ctx.c.id,
          kind: 'flow.wake',
          payload: { sessionId: s.id, seq: s.seq, kind },
          dedupeKey: `flow:${s.id}:${s.seq}:${kind}`,
          scheduledAt: at,
          maxAttempts: 3,
        });
      },
      log: (event, detail) => ctx.log(event, detail),
    };
  }

  function context(brandId, c, s, extra = {}) {
    const ctx = {
      brandId,
      c,
      s,
      sent: [],
      depth: 0,
      ...extra,
      log(event, { nodeId = null, nodeType = null, port = null, detail = null } = {}) {
        repo.insertEvent(brandId, {
          sessionId: s.id,
          flowId: s.flowId,
          version: s.version,
          nodeId,
          nodeType,
          courseId: repo.conversation(brandId, c.id)?.course_id ?? null,
          event,
          port,
          detail,
          at: now(),
        });
      },
    };
    ctx.io = realIo(ctx);
    return ctx;
  }

  // Guarda la sesión con su candado y ejecuta las acciones finales (que pueden disparar ganchos de cancelación).
  function persist(ctx, readSeq, finals = {}) {
    const { brandId, s } = ctx;
    if (!repo.saveSession(brandId, s, readSeq, now()))
      throw Object.assign(new Error('La sesión del recorrido cambió mientras avanzaba.'), { code: 'stale_session' });
    if (finals.handoff) handoff(ctx, finals.handoff);
    if (finals.resolve) resolveConversation(ctx);
    if (finals.goto) gotoFlow(ctx, finals.goto);
    emit(brandId, { flowId: s.flowId, sessionId: s.id, conversationId: ctx.c.id, state: s.state, outcome: s.outcome });
  }

  function triggerFor(ctx) {
    return (
      ctx.trigger ||
      repo.lastCustomerMessage(ctx.brandId, ctx.c.id) || { id: 'chatflow-' + ctx.s.id, created_at: now() }
    );
  }

  // Pasar con una persona: el asistente se apaga en la conversación, queda en espera y en la cola (replies.escalate,
  // conciliación fila 20) y, si se eligió, se asigna (operations.assign hasta que exista routing.assign, fila 27).
  function handoff(ctx, { to = 'queue', userId = null, notice = false } = {}) {
    const c = repo.conversation(ctx.brandId, ctx.c.id);
    if (!c) return;
    if (notice && ctx.io.windowOpen()) {
      const ref = 'chatflow-error:' + ctx.s.id;
      if (!repo.messageByRef(ref)) {
        const id = host.insertMessage(
          c,
          null,
          forBrand(db, ctx.brandId, copy.escalate),
          'automation',
          ref,
          null,
          null,
          null,
          {
            category: 'service',
          },
        );
        ctx.sent.push({ id, text: copy.escalate });
      }
    }
    if (c.bot_enabled && !c.assigned_to) svc.replies.escalate(c, triggerFor(ctx));
    if (to === 'user' && userId) {
      const r = savepoint('chatflow_assign', () =>
        svc.operations.assign(repo.conversation(ctx.brandId, c.id), userId, null, 'Recorrido'),
      );
      if (!r.ok) ctx.log('error', { detail: 'No se asignó a la persona elegida: ' + r.error?.message });
    }
    ctx.handedOff = true;
  }

  function resolveConversation(ctx) {
    const c = repo.conversation(ctx.brandId, ctx.c.id);
    const api = lifecycle();
    if (api) api.resolve(c, null, { by: 'automation', reason: 'chatflow' });
    else
      db.prepare("UPDATE conversations SET bot_enabled=0,status='resolved',updated_at=? WHERE id=?").run(now(), c.id);
  }

  function gotoFlow(ctx, { flowId, vars }) {
    const target = repo.published(ctx.brandId, flowId);
    if (!target || target.status !== 'active' || ctx.depth + 1 >= MAX_DEPTH) {
      ctx.log('error', { detail: 'No se pudo ir al otro recorrido (sin publicar, en pausa o demasiados saltos).' });
      return;
    }
    start(repo.conversation(ctx.brandId, ctx.c.id), target, {
      startedBy: 'flow',
      trigger: ctx.trigger,
      vars,
      depth: ctx.depth + 1,
      sent: ctx.sent,
    });
  }

  // Inicia una sesión y la avanza hasta su primera espera. Dentro de una transacción. Devuelve el contexto.
  function start(
    c,
    flow,
    { startedBy = 'message', sourceKey = null, trigger = null, vars = {}, depth = 0, sent } = {},
  ) {
    const brandId = c.brand_id;
    const t = now();
    const env0 = makeEnv({ graph: flow.graph, settings: flow.settings, io: null, now: t });
    const s = newSession({ id: randomUUID(), flowId: flow.id, version: flow.version, graph: env0.graph, now: t, vars });
    repo.insertSession(brandId, {
      ...s,
      conversationId: c.id,
      courseId: c.course_id,
      startedBy,
      sourceKey,
    });
    const ctx = context(brandId, c, s, { trigger, depth });
    if (sent) ctx.sent = sent;
    // El mensaje que inició el recorrido (paso «¿Qué curso te interesa?»): sólo si lo inició un mensaje de la persona.
    ctx.startText = startedBy === 'message' ? String(trigger?.text || '') : '';
    ctx.flowName = flow.name;
    ctx.log('start', { detail: startedBy });
    const env = { ...env0, io: ctx.io };
    const finals = advance(s, env);
    persist(ctx, 0, finals);
    return ctx;
  }

  // Volver a empezar: «siempre», «una vez por conversación» o con un descanso en minutos (ajuste `reentry`).
  function reentryAllows(brandId, c, flow) {
    const last = repo.lastSessionOf(brandId, c.id, flow.id);
    if (!last) return true;
    const reentry = flow.settings?.reentry ?? 'always';
    if (reentry === 'once_conversation') return false;
    if (reentry && typeof reentry === 'object')
      return (last.ended_at ?? now()) + reentry.cooldownMinutes * 60_000 <= now();
    return true;
  }

  // ¿Qué recorrido publicado arranca con este mensaje? Primero los de palabra clave, luego «primer mensaje de la
  // conversación» y al final «cualquier mensaje»; dentro de cada tipo, el más antiguo.
  const byKeyword = (flows, m) =>
    flows.filter(
      f =>
        f.start?.type === 'keyword' &&
        keywordMatch(m.text || '', f.start.keywords || [], { mode: f.start.mode || 'contains' }) !== null,
    );
  // ¿Este mensaje es la palabra clave de un recorrido que puede volver a empezar? Es la persona que escribe otra vez
  // la palabra (o toca de nuevo el anuncio, que manda su frase) mientras un recorrido espera su respuesta. Sólo los
  // recorridos que se pueden repetir «siempre»: con «una vez por conversación» o con un descanso, la palabra no
  // reinicia y sigue contando como una respuesta que no se entendió.
  const restartsWith = (c, m) =>
    byKeyword(repo.startable(c.brand_id), m).some(f => (f.settings?.reentry ?? 'always') === 'always');
  function pick(c, m) {
    const brandId = c.brand_id;
    const flows = repo.startable(brandId);
    if (!flows.length) return null;
    const first = repo.customerMessages(brandId, c.id) === 1;
    const ofType = type => flows.filter(f => f.start?.type === type);
    const candidates = [...byKeyword(flows, m), ...(first ? ofType('first_message') : []), ...ofType('any_message')];
    for (const f of candidates) {
      if (!reentryAllows(brandId, c, f)) continue;
      // Un recorrido propio para el curso de la conversación (ajuste courseOverrides; una sola redirección).
      const other = f.settings?.courseOverrides?.[c.course_id];
      if (other && other !== f.id) {
        const target = repo.published(brandId, other);
        if (target?.status === 'active') return target;
      }
      return f;
    }
    return null;
  }

  // Una fila en reply_log por cada mensaje que atiende un recorrido: el embudo de Actividad y el «por qué respondió»
  // del chat siguen completos (diseño §3.2).
  function logReply(ctx, m, action) {
    if (!m?.id || repo.replyLogged(ctx.brandId, m.id)) return;
    const first = ctx.sent[0] || null;
    repo.replyLog(ctx.brandId, {
      id: randomUUID(),
      conversationId: ctx.c.id,
      triggerId: m.id,
      replyId: first?.id ?? null,
      mode: svc.replies.settings(ctx.brandId).mode,
      action,
      text: first?.text ?? '',
      sources: [{ type: 'flow', id: ctx.s.flowId, version: ctx.s.version, node: ctx.s.nodeId }],
      reason: 'Recorrido «' + (ctx.flowName || '') + '» (versión ' + ctx.s.version + ').',
      at: now(),
    });
  }

  function endRow(brandId, row, outcome) {
    const ended = repo.endActive(brandId, row.conversation_id, outcome, now());
    if (ended)
      repo.insertEvent(brandId, {
        sessionId: ended.id,
        flowId: ended.flow_id,
        version: ended.flow_version,
        nodeId: ended.node_id,
        courseId: ended.course_id,
        event: 'end',
        detail: outcome,
        at: now(),
      });
    if (ended)
      emit(brandId, {
        flowId: ended.flow_id,
        sessionId: ended.id,
        conversationId: row.conversation_id,
        state: 'ended',
        outcome,
      });
    return ended;
  }

  // Botones del nodo en espera, de vuelta en la respuesta del asistente (desvío, diseño §3.4).
  const reoffer = labels => plan =>
    plan.handoff || plan.intent === 'opt_out' || !['templates', 'autonomous'].includes(plan.mode)
      ? plan
      : {
          ...plan,
          buttons: labels,
          keepButtons: true,
          flow: null,
          ifAnswered: plan.ifAnswered ? { ...plan.ifAnswered, buttons: labels, keepButtons: true, flow: null } : null,
        };
  // Si el asistente terminó pasando la conversación a una persona, la sesión termina como «pasó a una persona».
  const afterDetour = (brandId, conversationId) => result => {
    if (result?.action !== 'escalated') return;
    const r = savepoint('chatflow_after', () => {
      const row = repo.activeSession(brandId, conversationId);
      if (row) endRow(brandId, row, 'handoff');
    });
    if (!r.ok) console.error('Chatflow afterDetour failed', r.error?.name);
  };

  // ---- el despachador: la persona escribió (dentro de la transacción del trabajo del asistente)
  function inbound(c, m) {
    const brandId = c.brand_id;
    const row = repo.activeSession(brandId, c.id);
    const speaks = brandSpeaks(brandId);
    if (row) {
      if (!speaks) {
        endRow(brandId, row, 'automation_off');
        return null;
      }
      if (svc.contacts.isOptOutText(m.text)) {
        endRow(brandId, row, 'opt_out');
        return null;
      }
      const flow = repo.version(brandId, row.flow_id, row.flow_version);
      const s = fromRow(row);
      const readSeq = s.seq;
      const ctx = context(brandId, c, s, { trigger: m });
      ctx.flowName = flow.name;
      const env = makeEnv({ graph: flow.graph, settings: flow.settings, io: ctx.io, now: now() });
      // Las opciones que se vuelven a ofrecer como botones tras un desvío. Una lista no cabe en 3 botones: no se
      // decora la respuesta del asistente (la lista sigue en el chat y se acepta el número o el nombre).
      const labels = s.waiting?.list ? null : s.waiting?.options?.map(o => o.label) || null;
      // Este mismo mensaje ya pasó por aquí y lo contestó el asistente (el trabajo se repitió): no se cuenta dos veces.
      if (s.lastInputMessageId === m.id)
        return {
          planOptions: { noFlow: true },
          decorate: labels && env.settings.reofferOnDetour ? reoffer(labels) : null,
          after: afterDetour(brandId, c.id),
        };
      const r = route(s, env, m, svc.replies.classify);
      if (r.kind === 'expired') {
        endRow(brandId, row, 'timeout');
        return startOrNull(c, m);
      }
      if (r.kind === 'interrupt') {
        endRow(brandId, row, 'handoff');
        return { planOptions: { noFlow: true } };
      }
      s.lastInputMessageId = m.id;
      s.unanswered = 0;
      if (r.kind === 'during_delay') {
        persist(ctx, readSeq);
        return { planOptions: { noFlow: true }, after: afterDetour(brandId, c.id) };
      }
      if (r.kind === 'intent') {
        ctx.log('input', { nodeId: s.nodeId, detail: 'intent ' + r.option.do.intent });
        rememberChoice(s, s.waiting, r.option);
        if (!r.stay) {
          s.state = 'ended';
          s.outcome = 'assistant';
          s.endNodeId = s.nodeId;
          s.waiting = null;
          s.expiresAt = null;
          ctx.log('end', { nodeId: s.nodeId, detail: 'assistant' });
          persist(ctx, readSeq);
          return { planOptions: { noFlow: true, forcedIntent: r.option.do.intent } };
        }
        persist(ctx, readSeq);
        return {
          planOptions: { noFlow: true, forcedIntent: r.option.do.intent },
          decorate: labels ? reoffer(labels) : null,
          after: afterDetour(brandId, c.id),
        };
      }
      if (r.kind === 'detour' && restartsWith(c, m)) {
        // No era una respuesta a lo que se esperaba, sino la palabra clave otra vez: la atención en curso se cierra
        // («restarted», fuera de las tasas) y el recorrido de esa palabra empieza de nuevo con este mismo mensaje.
        endRow(brandId, row, 'restarted');
        return startOrNull(c, m);
      }
      if (r.kind === 'detour') {
        s.waiting.misses = (s.waiting.misses || 0) + 1;
        ctx.log('miss', { nodeId: s.nodeId, detail: 'detour' });
        if (s.waiting.misses >= env.settings.maxMisses) {
          s.state = 'ended';
          s.outcome = 'left';
          s.endNodeId = s.nodeId;
          s.waiting = null;
          s.expiresAt = null;
          ctx.log('end', { nodeId: s.nodeId, detail: 'left' });
          persist(ctx, readSeq);
          return { planOptions: { noFlow: true } };
        }
        persist(ctx, readSeq);
        return {
          planOptions: { noFlow: true },
          decorate: env.settings.reofferOnDetour && labels ? reoffer(labels) : null,
          after: afterDetour(brandId, c.id),
        };
      }
      const finals = input(s, env, r);
      persist(ctx, readSeq, finals);
      logReply(ctx, m, ctx.handedOff ? 'escalated' : 'replied');
      return { done: true };
    }
    return startOrNull(c, m);
  }

  function startOrNull(c, m) {
    if (!brandSpeaks(c.brand_id)) return null;
    // Un número de WhatsApp que atiende toda la marca: si este mensaje elige o cambia el curso (con las mismas reglas
    // que el asistente), el recorrido se elige y empieza ya con ese curso. Sólo se guarda si de verdad arranca uno; si
    // no se puede cambiar (otra conversación abierta de ese curso), lo resuelve el asistente.
    const routed = svc.replies.routeCourse?.(c, m) ?? null;
    // Nombró otro curso pero tiene un pedido vigente: no se cambia solo y el recorrido no debe empezar con el curso
    // equivocado. Lo contesta el asistente, que se lo explica.
    if (routed?.blocked) return null;
    const next = routed?.course ? { ...c, course_id: routed.course.id, edition_id: routed.course.editionId } : c;
    const flow = pick(next, m);
    if (!flow) return null;
    if (
      routed?.course &&
      !svc.crm.moveConversation(c, routed.course.id, routed.course.editionId, {
        placeholder: Boolean(c.course_pending),
      })
    )
      return null;
    const ctx = start(c, flow, { startedBy: 'message', sourceKey: 'msg:' + m.id, trigger: m });
    if (ctx.s.state === 'ended' && !ctx.sent.length && !ctx.handedOff) return null; // no dijo nada: contesta el asistente
    ctx.s.lastInputMessageId = m.id;
    repo.saveSession(c.brand_id, ctx.s, ctx.s.seq, now());
    logReply(ctx, m, ctx.handedOff ? 'escalated' : 'replied');
    return { done: true };
  }

  // Falló el motor: lo suyo ya se deshizo. Se registra, se avisa a administración, la sesión termina con «error» y la
  // conversación pasa a una persona con un mensaje: nunca se queda muda.
  function onError(c, m, error) {
    const brandId = c.brand_id;
    const row = repo.activeAnyBrand(c.id);
    const t = now();
    if (row) endRow(brandId, row, 'error');
    repo.adminNotice(
      brandId,
      'chatflow_error',
      { conversationId: c.id, flowId: row?.flow_id ?? null, error: String(error?.message || error).slice(0, 200) },
      t,
    );
    const fresh = repo.conversation(brandId, c.id);
    if (!automatable(fresh)) return true;
    const ref = 'chatflow-error:' + m.id;
    let replyId = null;
    const w = svc.channel.windowOf(fresh);
    if (!(w.enforced && !w.open) && !repo.messageByRef(ref))
      replyId = host.insertMessage(
        fresh,
        null,
        forBrand(db, brandId, copy.escalate),
        'automation',
        ref,
        null,
        null,
        null,
        {
          category: 'service',
        },
      );
    svc.replies.escalate(fresh, m);
    if (!repo.replyLogged(brandId, m.id))
      repo.replyLog(brandId, {
        id: randomUUID(),
        conversationId: c.id,
        triggerId: m.id,
        replyId,
        mode: svc.replies.settings(brandId).mode,
        action: 'escalated',
        text: replyId ? copy.escalate : '',
        sources: row ? [{ type: 'flow', id: row.flow_id, version: row.flow_version, node: row.node_id }] : [],
        reason: 'El recorrido falló: pasa a una persona.',
        at: t,
      });
    return true;
  }

  // ---- paso durable «flow.wake»: espera cumplida, tiempo límite, recordatorio o ceder el turno
  const wake = {
    check(step) {
      const row = repo.session(step.brand_id, step.payload.sessionId);
      if (!row || row.state === 'ended') return { cancel: 'session_ended' };
      if (row.seq !== step.payload.seq) return { cancel: 'session_moved' };
      return null;
    },
    commit(step) {
      const brandId = step.brand_id;
      const row = repo.session(brandId, step.payload.sessionId);
      const c = repo.conversation(brandId, row.conversation_id);
      const r = savepoint('chatflow_wake', () => wakeUp(brandId, row, c, step.payload.kind));
      if (r.ok) return r.out;
      // Falló el motor en un paso diferido: se registra, termina con «error» y pasa a una persona.
      const handled = savepoint('chatflow_wake_error', () => {
        endRow(brandId, row, 'error');
        repo.adminNotice(
          brandId,
          'chatflow_error',
          { conversationId: c.id, flowId: row.flow_id, error: String(r.error?.message).slice(0, 200) },
          now(),
        );
        const fresh = repo.conversation(brandId, c.id);
        if (automatable(fresh)) {
          const s = fromRow(row);
          const ctx = context(brandId, fresh, s);
          handoff(ctx, { to: 'queue', notice: true });
        }
      });
      if (!handled.ok) throw r.error;
      return { error: true };
    },
  };

  function wakeUp(brandId, row, c, kind) {
    const flow = repo.version(brandId, row.flow_id, row.flow_version);
    const s = fromRow(row);
    const readSeq = s.seq;
    const ctx = context(brandId, c, s);
    ctx.flowName = flow.name;
    const env = makeEnv({ graph: flow.graph, settings: flow.settings, io: ctx.io, now: now() });
    const why = ctx.io.stop();
    if (why) {
      endRow(brandId, row, why);
      return { ended: why };
    }
    let finals = {};
    if (kind === 'delay' || kind === 'yield') {
      if (kind === 'delay') {
        ctx.log('exit', { nodeId: s.nodeId, port: 'next' });
        const to = env.target(s.nodeId, 'next');
        s.waiting = null;
        if (!to) {
          s.state = 'ended';
          s.outcome = 'completed';
          s.endNodeId = s.nodeId;
          ctx.log('end', { nodeId: s.nodeId, detail: 'completed' });
        } else s.nodeId = to;
      }
      if (s.state !== 'ended') {
        s.state = 'running';
        finals = advance(s, env);
      }
    } else if (kind === 'timeout') {
      if (s.state !== 'waiting') return { skipped: 'not_waiting' };
      ctx.log('timeout', { nodeId: s.nodeId });
      if (env.target(s.nodeId, 'timeout')) {
        s.waiting = null;
        s.expiresAt = null;
        s.nodeId = env.target(s.nodeId, 'timeout');
        s.state = 'running';
        finals = advance(s, env);
      } else {
        if (env.settings.exitText && ctx.io.windowOpen()) ctx.io.send({ text: env.settings.exitText });
        s.state = 'ended';
        s.outcome = 'timeout';
        s.endNodeId = s.nodeId;
        s.waiting = null;
        s.expiresAt = null;
        ctx.log('end', { nodeId: s.nodeId, detail: 'timeout' });
      }
    } else if (kind === 'reminder') {
      if (s.state !== 'waiting' || !env.settings.reminder?.text) return { skipped: 'not_waiting' };
      if (!ctx.io.windowOpen()) return { skipped: 'window_closed' };
      // «¿Qué curso te interesa?» recuerda con la misma lista numerada que se le mostró.
      const options = s.waiting?.options || (s.waiting?.titles || []).map(label => ({ label }));
      if (s.waiting?.list || s.waiting?.kind === 'course')
        ctx.io.send({ text: env.settings.reminder.text + '\n\n' + numberedOptions(options) });
      else
        ctx.io.send({ text: env.settings.reminder.text, buttons: options.length ? options.map(o => o.label) : null });
    }
    persist(ctx, readSeq, finals);
    host.broadcast('conversation', c.id);
    return { state: s.state, outcome: s.outcome };
  }

  // ---- gancho de cancelación: una persona tomó, asignó o cerró; o la persona pidió la baja
  function onCancel(conversationId, reason) {
    try {
      const brandId = repo.conversationBrand(conversationId);
      if (!brandId) return;
      const row = repo.activeSession(brandId, conversationId);
      if (!row) return;
      const outcome =
        reason === 'contact_opted_out'
          ? 'opt_out'
          : reason === 'human_takeover' || reason === 'owner_changed'
            ? 'human_takeover'
            : 'closed';
      endRow(brandId, row, outcome);
    } catch (error) {
      console.error('Chatflow cancel hook failed', error?.name);
    }
  }

  // Inicio manual desde el chat (equipo): sólo si el asistente está a cargo, la conversación está abierta y la
  // ventana permite escribir.
  function startManual(c, flow, clientRef) {
    const key = 'manual:' + clientRef;
    const existing = repo.sessionBySource(c.brand_id, key);
    if (existing) return { session: existing, duplicate: true };
    const ctx = start(c, flow, { startedBy: 'manual', sourceKey: key });
    return { session: repo.session(c.brand_id, ctx.s.id), duplicate: false };
  }

  function stopSession(brandId, conversationId) {
    const row = repo.activeSession(brandId, conversationId);
    if (!row) return null;
    return endRow(brandId, row, 'stopped');
  }

  return { inbound, onError, wake, onCancel, start, startManual, stopSession, endRow, automatable, brandSpeaks };
}
