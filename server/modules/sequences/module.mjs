// Secuencias de seguimiento (docs/PLAN_SECUENCIAS.md; diseño de automatización §5.8; conciliación, fila N-6).
//
// Una marca define quién entra, una lista de pasos con su momento (relativo a la inscripción o al inicio de la
// edición del catálogo) y cuándo para. Cada paso es un mensaje (plantilla aprobada de WhatsApp, texto o material) que
// sale por la única puerta de salida (host.insertMessage). Todo nace apagado: la marca (automatización encendida y
// asistente en «Plantillas» o «Autónomo») y cada secuencia.
//
// Rutas (con sesión, bajo /api/sequences). Lectura: equipo de la marca (inbox.view). Escritura: automation.manage.
// Inscribir, detener o reanudar en un chat: inbox.reply.
//   GET    /api/sequences?brand=&archived=1                 {sequences, brands, limits, labels}
//   POST   /api/sequences                                   {brandId,title,description?,courseId?,steps,settings,clientRef}
//   GET    /api/sequences/lists?brand=                      cursos, plantillas, materiales, etiquetas y datos de la marca
//   GET    /api/sequences/:id                               {sequence, canManage}
//   PUT    /api/sequences/:id                               {expectedRevision,title?,description?,courseId?,steps?,settings?}
//   POST   /api/sequences/:id/enable | /disable | /archive  {expectedRevision}  (apagar o archivar detiene lo vivo)
//   POST   /api/sequences/:id/preview                       {} → quién entraría y quién recibiría su paso ahora; no envía
//   GET    /api/sequences/:id/results                       inscritas, por estado y motivo, y por paso
//   GET    /api/sequences/:id/enrollments?state=&before=    inscripciones
//   GET    /api/sequences/enrollments/:eid                  {enrollment, events}
//   POST   /api/sequences/enrollments/:eid/stop | /resume   {}
//   GET    /api/sequences/conversations/:cid                {enrollments, sequences (las que se pueden inscribir)}
//   POST   /api/sequences/conversations/:cid                {sequenceId, clientRef} → 201 {enrollment}
// Para otros módulos (host.module('sequences')): enroll(conversation, sequenceId, {source, clientRef, userId}) y
// enrollInTx (dentro de una transacción ajena, p. ej. un recorrido). Tiempo real: 'sequences.changed'.
import { randomUUID } from 'node:crypto';
import { onConversationCancel } from '../../automation.mjs';
import { isOpen } from '../../service-hours.mjs';
import { forBrand } from '../../lib/real-mode.mjs';
import { createRepo } from './repo.mjs';
import { STEP_KIND, createEngine } from './engine.mjs';
import {
  LIMITS,
  ON_REPLY,
  REASONS,
  SEND_HOURS,
  STATES,
  TRIGGERS,
  WHEN_CLOSED,
  normalizeDefinition,
  normalizeSettings,
  reasonLabel,
  referencedIds,
  timingLabel,
} from './model.mjs';

const ID = '[A-Za-z0-9-]{1,64}';
const REF = /^[A-Za-z0-9-]{8,100}$/;
const SPEAKS = ['templates', 'autonomous'];
const PREFIX = '/api/sequences';

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

export default {
  name: 'sequences',
  create(host) {
    const { db, fail, access } = host;
    const svc = host.services;
    const repo = createRepo(db);
    const now = () => Date.now();
    const optional = name => {
      try {
        return host.module(name);
      } catch {
        return null;
      }
    };
    const emit = (brandId, data) =>
      setImmediate(() => {
        try {
          host.realtime.emit('sequences.changed', { brandId, data });
        } catch {
          /* el aviso en vivo es una cortesía */
        }
      });
    const speaks = brandId =>
      Boolean(svc.automation.enabledFor(brandId)) && SPEAKS.includes(svc.replies.settings(brandId)?.mode);

    // Lo que el motor necesita del resto del servidor. Todo síncrono y sin red: corre dentro de transacciones.
    const deps = {
      speaks,
      policy: brandId => svc.operations.settings(brandId),
      suppressed: (brandId, contactId) => Boolean(optional('audiences')?.suppressed?.(brandId, contactId)),
      isOptOutText: text => Boolean(svc.contacts.isOptOutText(text)),
      realText: (brandId, text) => forBrand(db, brandId, text),
      windowOpen(c) {
        const w = svc.channel.windowOf(c);
        return !(w.enforced && !w.open);
      },
      canSend: c => svc.whatsapp?.canSendFrom?.(c.wa_number, { to: c.wa_peer || null }) ?? { ok: true },
      // ¿Un recorrido atiende ahora esta conversación? (sólo lectura, por el módulo de recorridos y con la marca)
      flowActive: c => Boolean(optional('chatflows')?.repo?.activeSession?.(c.brand_id, c.id)),
      template(c, templateId) {
        const api = optional('wa-templates');
        if (!api?.forConversation) return { reason: 'Las plantillas de WhatsApp no están disponibles' };
        return api.forConversation(c, String(templateId || ''));
      },
      material(c, templateId) {
        try {
          const prepared = svc.catalogue.prepare(c, { templateId });
          return { text: prepared.text, prepared };
        } catch (error) {
          if (error?.status === 409 || error?.status === 404)
            return { reason: String(error.message).replace(/\.$/, '') };
          throw error;
        }
      },
      conditionRecord(c, contactId, t) {
        let attr = {};
        try {
          if (contactId) attr = optional('attributes')?.record(c.brand_id, contactId)?.attr ?? {};
        } catch {
          attr = {};
        }
        const policy = svc.operations.settings(c.brand_id);
        return {
          attr,
          tags: attr.etiquetas || [],
          course: c.course_id,
          channel: c.channel,
          open: isOpen(t, policy),
          clock: clockIn(t, policy.timezone),
        };
      },
      // La única puerta de salida: ventana, modo escucha, entrega, reintentos y categoría de costo como en todo.
      insertMessage(c, plan, ref) {
        if (plan.kind === 'template')
          return host.insertMessage(c, null, plan.text, 'automation', ref, null, null, null, {
            category: plan.category,
            template: plan.template,
            buttons: plan.buttons?.length ? plan.buttons : undefined,
            keepButtons: Boolean(plan.buttons?.length),
          });
        if (plan.kind === 'material')
          return host.insertMessage(
            c,
            null,
            plan.text,
            'automation',
            ref,
            null,
            plan.prepared?.flyerSnapshot ? c.course_id : null,
            plan.prepared,
            { category: 'service' },
          );
        return host.insertMessage(c, null, plan.text, 'automation', ref, null, null, null, { category: 'service' });
      },
      enqueueInTx: input => svc.automation.enqueueInTx(input),
      changed: (brandId, data) => emit(brandId, data),
      conversationChanged: id => setImmediate(() => host.broadcast('conversation', id)),
    };
    const engine = createEngine({ db, repo, deps, now });

    // Cableado: el paso durable y el gancho de «una persona manda / se cerró / pidió la baja».
    svc.automation.register(STEP_KIND, engine.handler);
    onConversationCancel(db, engine.onCancel);

    // ---- entrada
    const text = (v, max) =>
      typeof v === 'string'
        ? v
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, max + 1)
        : '';
    const revisionOf = input => {
      if (!Number.isInteger(input?.expectedRevision))
        throw fail(400, 'Falta expectedRevision: recarga la secuencia.', { code: 'invalid_request' });
      return input.expectedRevision;
    };
    const refOf = input => {
      if (typeof input?.clientRef !== 'string' || !REF.test(input.clientRef))
        throw fail(400, 'Falta clientRef.', { code: 'invalid_request', field: 'clientRef' });
      return input.clientRef;
    };
    const stale = () =>
      fail(409, 'Alguien más guardó esta secuencia. Recárgala para ver sus cambios.', { code: 'stale_record' });
    const waTemplatesOf = brandId => {
      try {
        return optional('wa-templates')?.flowTemplates?.(brandId) ?? [];
      } catch {
        return [];
      }
    };

    // Título, curso, pasos y ajustes validados contra LA MISMA marca (curso, plantillas y materiales).
    function cleanDefinition(brandId, input, current = null) {
      const title = input.title === undefined && current ? current.title : text(input.title, LIMITS.titleLength);
      if (!title) throw fail(400, 'Escribe el nombre de la secuencia.', { code: 'invalid_request', field: 'title' });
      if (title.length > LIMITS.titleLength)
        throw fail(400, `El nombre admite hasta ${LIMITS.titleLength} caracteres.`, { code: 'invalid_request' });
      const description =
        input.description === undefined && current
          ? current.description
          : text(input.description ?? '', LIMITS.descriptionLength).slice(0, LIMITS.descriptionLength);
      let courseId = input.courseId === undefined && current ? current.course_id : input.courseId || null;
      if (courseId && !repo.course(brandId, String(courseId)))
        throw fail(400, 'El curso no es de esta marca.', { code: 'invalid_request', field: 'courseId' });
      const def = normalizeDefinition({
        steps: input.steps === undefined && current ? current.steps : input.steps,
        settings: input.settings === undefined && current ? current.settings : input.settings,
      });
      if (!def.steps.length) def.problems.push('Agrega al menos un paso.');
      const refs = referencedIds(def.steps);
      const templates = new Set(waTemplatesOf(brandId).map(t => t.id));
      for (const id of refs.templates)
        if (!templates.has(id)) def.problems.push('Una plantilla elegida no es de esta marca o ya no existe.');
      for (const id of refs.materials)
        if (!repo.material(brandId, id)) def.problems.push('Un material elegido no es de esta marca o ya no existe.');
      if (def.problems.length)
        throw fail(400, def.problems[0], {
          code: 'sequence_invalid',
          details: { problems: [...new Set(def.problems)] },
        });
      return {
        title,
        description,
        courseId: courseId ? String(courseId) : null,
        steps: def.steps,
        settings: def.settings,
      };
    }

    function locate(user, id, perm) {
      const brandId = repo.brandOf(id);
      if (!brandId) throw fail(404, 'Secuencia no disponible.', { code: 'not_found' });
      access.require(user, perm, brandId);
      return repo.sequence(brandId, id);
    }

    // ---- vistas
    const view = s => ({
      id: s.id,
      brandId: s.brand_id,
      title: s.title,
      description: s.description,
      courseId: s.course_id,
      courseTitle: s.course_id ? (repo.course(s.brand_id, s.course_id)?.title ?? null) : null,
      steps: s.steps.map((st, i) => ({ ...st, index: i, when: timingLabel(st.timing) })),
      settings: normalizeSettings(s.settings),
      enabled: s.enabled,
      archived: Boolean(s.archived_at),
      revision: s.revision,
      updatedAt: s.updated_at,
      createdAt: s.created_at,
    });
    const enrollmentView = e =>
      e && {
        id: e.id,
        sequenceId: e.sequence_id,
        sequenceTitle: e.title ?? repo.sequence(e.brand_id, e.sequence_id)?.title ?? '',
        conversationId: e.conversation_id,
        customerName: e.customer_name ?? undefined,
        state: e.state,
        stateLabel: STATES[e.state] ?? e.state,
        reason: e.reason,
        reasonLabel: reasonLabel(e.reason),
        nextIndex: e.next_index,
        steps: e.definition.steps.length,
        nextDueAt: e.state === 'active' ? e.next_due_at : null,
        lastSentAt: e.last_sent_at,
        source: e.source,
        startedAt: e.started_at,
        endedAt: e.ended_at,
        revision: e.revision,
      };
    const brandsOf = user => access.brandIds(user, 'inbox.view');
    const attending = brandId => ({
      automation: Boolean(svc.automation.enabledFor(brandId)),
      mode: svc.replies.settings(brandId)?.mode ?? 'off',
      speaks: speaks(brandId),
    });

    // ---- escrituras (síncronas, sin red)
    function create(user, input) {
      const brandId = text(input.brandId, 64);
      access.require(user, 'automation.manage', brandId);
      const clientRef = refOf(input);
      return host.transaction(db, () => {
        const existing = repo.sequenceByRef(brandId, clientRef);
        if (existing) return { sequence: existing, duplicate: true };
        if (repo.count(brandId) >= LIMITS.sequencesPerBrand)
          throw fail(409, `Una marca admite hasta ${LIMITS.sequencesPerBrand} secuencias.`, { code: 'sequence_limit' });
        const d = cleanDefinition(brandId, input);
        const id = randomUUID();
        repo.insertSequence({ id, brandId, ...d, clientRef, userId: user.id, at: now() });
        return { sequence: repo.sequence(brandId, id), duplicate: false };
      });
    }
    function update(user, id, input) {
      const expected = revisionOf(input);
      return host.transaction(db, () => {
        const s = locate(user, id, 'automation.manage');
        if (s.archived_at) throw fail(409, 'La secuencia está archivada.', { code: 'archived' });
        if (s.revision !== expected) throw stale();
        const d = cleanDefinition(s.brand_id, input, s);
        if (!repo.updateSequence(s.brand_id, s.id, expected, { ...d, userId: user.id, at: now() })) throw stale();
        return repo.sequence(s.brand_id, s.id);
      });
    }
    function setStatus(user, id, input, action) {
      const expected = revisionOf(input);
      return host.transaction(db, () => {
        const s = locate(user, id, 'automation.manage');
        if (s.archived_at) throw fail(409, 'La secuencia está archivada.', { code: 'archived' });
        if (s.revision !== expected) throw stale();
        const t = now();
        let stopped = 0;
        if (action === 'archive') {
          if (!repo.archive(s.brand_id, s.id, expected, user.id, t)) throw stale();
          stopped = engine.stopAll(s.brand_id, s.id, 'sequence_off', t);
        } else {
          const enabled = action === 'enable';
          if (enabled && !s.steps.length)
            throw fail(409, 'Agrega al menos un paso antes de encenderla.', { code: 'sequence_invalid' });
          // Al encender, la entrada automática mira sólo lo que llegue desde ahora.
          const values = enabled
            ? { enabled: true, enabledAt: t, cursor: s.enabled ? s.trigger_cursor : repo.maxMessageSeq() }
            : { enabled: false, enabledAt: s.enabled_at, cursor: s.trigger_cursor };
          if (!repo.setEnabled(s.brand_id, s.id, expected, values, user.id, t)) throw stale();
          if (!enabled) stopped = engine.stopAll(s.brand_id, s.id, 'sequence_off', t);
        }
        return { sequence: repo.sequence(s.brand_id, s.id), stopped };
      });
    }
    const REFUSED = {
      sequence_off: [409, 'La secuencia está apagada o archivada.'],
      automation_off: [409, 'La automatización de la marca está apagada o su asistente no responde solo.'],
      other_course: [409, 'La secuencia es de otro curso.'],
      closed: [409, 'La conversación está cerrada.'],
      blocked: [409, 'La conversación está bloqueada.'],
      opt_out: [409, 'La persona pidió no recibir mensajes.'],
      suppressed: [409, 'La persona está en una lista de exclusión.'],
      enrolled: [409, 'La persona ya se inscribió o pagó el curso.'],
      already_enrolled: [409, 'La persona ya está en esta secuencia.'],
      not_found: [404, 'Conversación no disponible.'],
    };
    // Para otros módulos: inscribir dentro de SU transacción (un recorrido, una regla). → {enrollment}|{refused}
    function enrollInTx(c, sequenceId, { source = 'flow', clientRef = null, userId = null } = {}) {
      const seq = repo.sequence(c.brand_id, String(sequenceId || ''));
      if (!seq) return { refused: 'sequence_off' };
      return engine.enrollInTx(c, seq, { source, clientRef, userId });
    }
    function enroll(c, sequenceId, options = {}) {
      return host.transaction(db, () => enrollInTx(repo.conversation(c.brand_id, c.id), sequenceId, options));
    }

    // ---- resultados
    function results(s) {
      const settings = normalizeSettings(s.settings);
      const counts = repo.stepCounts(s.brand_id, s.id);
      const states = repo.stateCounts(s.brand_id, s.id);
      const converted = new Map(
        repo.convertedByStep(s.brand_id, s.id, settings.conversionDays * 86_400_000).map(r => [r.step_index, r.n]),
      );
      const total = ev => counts.filter(r => r.event === ev).reduce((n, r) => n + r.n, 0);
      const byState = Object.fromEntries(Object.keys(STATES).map(k => [k, 0]));
      const stopped = {};
      for (const r of states) {
        byState[r.state] = (byState[r.state] ?? 0) + r.n;
        if (r.state === 'stopped' || r.state === 'paused')
          stopped[r.state + ':' + r.reason] = {
            state: r.state,
            reason: r.reason,
            label: reasonLabel(r.reason),
            n: r.n,
          };
      }
      const steps = s.steps.map((st, index) => {
        const of = ev => counts.filter(r => r.step_index === index && r.event === ev);
        const skipped = {};
        for (const r of of('skipped')) skipped[r.detail] = { label: reasonLabel(r.detail), n: r.n };
        return {
          index,
          when: timingLabel(st.timing),
          kind: st.send.kind,
          sent: of('sent').reduce((n, r) => n + r.n, 0),
          replied: of('replied').reduce((n, r) => n + r.n, 0),
          saidYes: of('said_yes').reduce((n, r) => n + r.n, 0),
          saidNo: of('said_no').reduce((n, r) => n + r.n, 0),
          converted: converted.get(index) ?? 0,
          skipped,
        };
      });
      return {
        enrolled: total('enrolled'),
        sent: total('sent'),
        replied: total('replied'),
        saidYes: total('said_yes'),
        saidNo: total('said_no'),
        byState,
        stopped: Object.values(stopped).sort((a, b) => b.n - a.n),
        conversionDays: settings.conversionDays,
        steps,
      };
    }

    // ---- rutas
    async function handle(req, res, path, user, url) {
      if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
      const method = req.method;
      const send = (status, value) => (host.json(res, status, value), true);
      let m;
      if (path === PREFIX && method === 'GET') {
        const brand = url.searchParams.get('brand');
        const visible = brandsOf(user);
        let ids;
        if (brand) {
          access.require(user, 'inbox.view', brand);
          ids = [brand];
        } else {
          ids = visible;
          if (!ids.length) access.require(user, 'inbox.view');
        }
        return send(200, {
          sequences: repo.sequences(ids, { archived: url.searchParams.get('archived') === '1' }).map(view),
          brands: (visible.length ? visible : ids).map(id => ({
            id,
            name: repo.brandName(id),
            canManage: access.can(user, 'automation.manage', id),
            attending: attending(id),
          })),
          limits: LIMITS,
          labels: {
            triggers: TRIGGERS,
            sendHours: SEND_HOURS,
            onReply: ON_REPLY,
            whenClosed: WHEN_CLOSED,
            reasons: REASONS,
            states: STATES,
          },
        });
      }
      if (path === PREFIX + '/lists' && method === 'GET') {
        const brandId = text(url.searchParams.get('brand'), 64);
        access.require(user, 'inbox.view', brandId);
        let attributes = [];
        try {
          attributes = (optional('attributes')?.definitions(brandId, { archived: false }) ?? []).map(d => ({
            key: d.key,
            label: d.label,
          }));
        } catch {
          attributes = [];
        }
        return send(200, {
          lists: {
            courses: repo.courses(brandId),
            materials: repo.materials(brandId),
            waTemplates: waTemplatesOf(brandId),
            tags: repo.tags(brandId),
            attributes,
          },
        });
      }
      if (path === PREFIX && method === 'POST') {
        const r = create(user, (await host.body(req)) ?? {});
        if (!r.duplicate) {
          host.audit(user, 'sequence.created', r.sequence.id);
          emit(r.sequence.brand_id, { sequenceId: r.sequence.id, kind: 'created' });
        }
        return send(r.duplicate ? 200 : 201, { sequence: view(r.sequence), duplicate: r.duplicate });
      }
      if ((m = path.match(new RegExp(`^${PREFIX}/conversations/(${ID})$`)))) {
        const c = host.accessConversation(m[1], user);
        access.require(user, 'inbox.view', c.brand_id);
        if (method === 'GET')
          return send(200, {
            enrollments: repo.ofConversation(c.brand_id, c.id).map(enrollmentView),
            sequences: repo
              .sequences([c.brand_id])
              .filter(s => s.enabled && (!s.course_id || s.course_id === c.course_id))
              .map(s => ({ id: s.id, title: s.title })),
            canEnroll: access.can(user, 'inbox.reply', c.brand_id),
          });
        if (method !== 'POST') return false;
        access.require(user, 'inbox.reply', c.brand_id);
        const input = (await host.body(req)) ?? {};
        const clientRef = refOf(input);
        const r = host.transaction(db, () => {
          const fresh = repo.conversation(c.brand_id, c.id);
          const seq = repo.sequence(c.brand_id, text(input.sequenceId, 64));
          if (!seq) throw fail(404, 'Secuencia no disponible.', { code: 'not_found' });
          const out = engine.enrollInTx(fresh, seq, { source: 'manual', userId: user.id, clientRef });
          if (out.refused) {
            const [status, message] = REFUSED[out.refused] ?? [409, reasonLabel(out.refused)];
            throw fail(status, message, { code: out.refused });
          }
          return out;
        });
        if (!r.duplicate) host.audit(user, 'sequence.enrolled', r.enrollment.id);
        return send(r.duplicate ? 200 : 201, { enrollment: enrollmentView(r.enrollment), duplicate: r.duplicate });
      }
      if ((m = path.match(new RegExp(`^${PREFIX}/enrollments/(${ID})(?:/(stop|resume))?$`)))) {
        const brandId = repo.enrollmentBrand(m[1]);
        if (!brandId) throw fail(404, 'Inscripción no disponible.', { code: 'not_found' });
        access.require(user, 'inbox.view', brandId);
        const e = repo.enrollment(brandId, m[1]);
        // Ver la conversación es requisito para ver o tocar su inscripción (asesores: sólo las suyas o sin dueño).
        host.accessConversation(e.conversation_id, user);
        if (method === 'GET' && !m[2])
          return send(200, {
            enrollment: enrollmentView(e),
            events: repo.eventsOf(brandId, e.id).map(ev => ({ ...ev, label: reasonLabel(ev.detail) })),
          });
        if (method !== 'POST' || !m[2]) return false;
        access.require(user, 'inbox.reply', brandId);
        await host.body(req);
        const out = host.transaction(db, () => {
          const fresh = repo.enrollment(brandId, e.id);
          if (m[2] === 'stop') return engine.stop(fresh, now());
          if (fresh.state !== 'paused')
            throw fail(409, 'Sólo se reanuda una inscripción en pausa.', { code: 'not_paused' });
          if (!speaks(brandId)) throw fail(409, REFUSED.automation_off[1], { code: 'automation_off' });
          const seq = repo.sequence(brandId, fresh.sequence_id);
          if (!seq?.enabled || seq.archived_at) throw fail(409, REFUSED.sequence_off[1], { code: 'sequence_off' });
          return engine.resume(fresh, now());
        });
        host.audit(user, 'sequence.' + m[2], e.id);
        host.broadcast('conversation', e.conversation_id);
        return send(200, { enrollment: enrollmentView(repo.enrollment(brandId, out.id)) });
      }
      if (!(m = path.match(new RegExp(`^${PREFIX}/(${ID})(?:/([a-z]+))?$`)))) return false;
      const [, id, rest = ''] = m;
      if (method === 'GET' && rest === '') {
        const s = locate(user, id, 'inbox.view');
        return send(200, {
          sequence: view(s),
          canManage: access.can(user, 'automation.manage', s.brand_id),
          attending: attending(s.brand_id),
        });
      }
      if (method === 'GET' && rest === 'results')
        return send(200, { results: results(locate(user, id, 'inbox.view')) });
      if (method === 'GET' && rest === 'enrollments') {
        const s = locate(user, id, 'inbox.view');
        const state = Object.hasOwn(STATES, url.searchParams.get('state')) ? url.searchParams.get('state') : null;
        return send(200, {
          enrollments: repo
            .ofSequence(s.brand_id, s.id, {
              state,
              before: Number(url.searchParams.get('before')) || null,
              limit: Number(url.searchParams.get('limit')) || 50,
            })
            .map(enrollmentView),
        });
      }
      if (method === 'PUT' && rest === '') {
        const s = update(user, id, (await host.body(req)) ?? {});
        host.audit(user, 'sequence.updated', id);
        emit(s.brand_id, { sequenceId: id, kind: 'updated' });
        return send(200, { sequence: view(s) });
      }
      if (method !== 'POST') return false;
      const input = (await host.body(req)) ?? {};
      if (rest === 'preview') {
        const s = locate(user, id, 'inbox.view');
        host.rate('sequences.preview:' + user.id, 30);
        return send(200, { preview: engine.preview(s) });
      }
      if (['enable', 'disable', 'archive'].includes(rest)) {
        const r = setStatus(user, id, input, rest);
        host.audit(user, 'sequence.' + rest, id);
        emit(r.sequence.brand_id, { sequenceId: id, kind: rest });
        return send(200, { sequence: view(r.sequence), stopped: r.stopped });
      }
      return false;
    }

    return {
      handle,
      tick: () => engine.sweep(fn => host.transaction(db, fn)),
      enroll,
      enrollInTx,
      engine,
      repo,
    };
  },
  timers: [{ name: 'barrido', everyMs: 5000, testEveryMs: 200, run: api => api.tick() }],
};
