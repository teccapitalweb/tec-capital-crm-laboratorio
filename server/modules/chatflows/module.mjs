// Recorridos de conversación (docs/PLAN_RECORRIDOS.md; diseño de automatización §6; conciliación, filas 2, 3 y N-4).
//
// Un recorrido es un grafo de pasos (public/kit/shared/flow-model.js) con un BORRADOR que se edita y VERSIONES
// publicadas que no cambian. Atiende solo a quien escribe cuando está publicado y activo, la automatización de la
// marca está encendida y su asistente responde solo. Todo nace apagado.
//
// Rutas (con sesión, bajo /api/chatflows). Lectura: equipo de la marca (inbox.view). Escritura: automation.manage.
//   GET    /api/chatflows?brand=                       {flows:[resumen], limits, startTypes}
//   POST   /api/chatflows                              {brandId, name, description?, graph?, settings?, start?,
//                                                      fromFlowId?, clientRef} → 201 {flow}
//   GET    /api/chatflows/:id                          {flow, versions, issues}
//   PUT    /api/chatflows/:id/draft                    {expectedRevision, graph?, settings?, start?, name?,
//                                                      description?} → {flow, issues}
//   POST   /api/chatflows/:id/validate                 {graph?, settings?, start?} → {ok, issues}
//   POST   /api/chatflows/:id/publish                  {expectedRevision, note?} → {flow, version} · 422 {issues}
//   POST   /api/chatflows/:id/activate | /pause        {expectedRevision, stopSessions?} → {flow}
//   POST   /api/chatflows/:id/archive                  {expectedRevision} → {flow}
//   POST   /api/chatflows/:id/duplicate                {clientRef, name?} → 201 {flow}
//   POST   /api/chatflows/:id/simulate                 {graph?, settings?, version?, state?, input?, courseId?,
//                                                      channel?} → {messages, state, trace, waiting, ended, outcome, notes}
//   GET    /api/chatflows/:id/versions/:v              {version}
//   GET    /api/chatflows/:id/sessions?state=&before=  {sessions}
//   GET    /api/chatflows/:id/sessions/:sid            {session, events}
//   GET    /api/chatflows/:id/log?limit=               {events}
//   GET    /api/chatflows/lists?brand=                 listas de la marca para el editor (cursos, materiales…)
//   GET    /api/chatflows/:id/analytics?version=&days= rendimiento por paso, sólo cifras agregadas (analytics.mjs)
//   POST   /api/chatflows/:id/suggestions              {} → sugerencias por reglas y con IA (review.mjs)
//   GET    /api/chatflows/conversations/:cid           {session | null}                        (inbox.view)
//   POST   /api/chatflows/conversations/:cid           {flowId, clientRef} → 201 {session}       (inbox.reply)
//   DELETE /api/chatflows/conversations/:cid           {stopped}                                (inbox.reply)
// Tiempo real v2: 'chatflows.changed' {brandId, data:{flowId, …}}.
import { randomUUID } from 'node:crypto';
import { onConversationCancel } from '../../automation.mjs';
import { isOpen } from '../../service-hours.mjs';
import { templateValues } from '../../catalogue.mjs';
import * as copy from '../../reply-copy.mjs';
import { forBrand, isRealBrand } from '../../lib/real-mode.mjs';
import {
  LIMITS,
  VARIABLE_RE,
  emptyGraph,
  normalizeSettings,
  repairGraph,
  validateGraph,
  validateSettings,
} from '../../../public/kit/shared/flow-model.js';
import {
  CAPS,
  advance,
  input as feed,
  makeEnv,
  newSession,
  rememberChoice,
  route,
  unsupportedProblems,
  waitOf,
} from './engine.mjs';
import { createRepo } from './repo.mjs';
import { createAnalytics, periodOf } from './analytics.mjs';
import { REVIEW_KINDS, cleanSuggestions, outlineOf, ruleSuggestions } from './review.mjs';
import { FLOW_FILE_MIMES, UNAVAILABLE_TYPES } from '../../../public/kit/shared/flow-support.js';
import { discard, receive, store } from '../../lib/upload.mjs';
import { createRuntime } from './runtime.mjs';
import { keywordMatch } from '../../lib/conditions.mjs';

const ID = '[A-Za-z0-9-]{1,64}';
const REF = /^[A-Za-z0-9-]{8,100}$/;
const START_TYPES = Object.freeze({
  manual: 'Sólo a mano, desde el chat',
  first_message: 'Primer mensaje de la conversación',
  keyword: 'Mensaje con una palabra clave',
  any_message: 'Cualquier mensaje (si no hay otro recorrido en curso)',
});
const KEYWORD_MODES = ['contains', 'exact', 'fuzzy'];

export default {
  name: 'chatflows',
  create(host) {
    const { db, fail, access } = host;
    const svc = host.services;
    const repo = createRepo(db);
    const analytics = createAnalytics(db);
    const now = () => Date.now();
    const emit = (brandId, data) =>
      setImmediate(() => {
        try {
          host.realtime.emit('chatflows.changed', { brandId, data });
        } catch {
          /* el aviso en vivo es una cortesía: la pantalla vuelve a leer al entrar */
        }
      });
    const runtime = createRuntime({ host, repo, now, emit });

    // Cableado: el despachador del entrante, el paso durable de las esperas y el gancho de «una persona manda».
    // (Una instalación sin despachador, como el registro de datos de persona en sus pruebas, sólo omite el entrante.)
    host.dispatch?.register('chatflows', { order: 40, inbound: runtime.inbound, onError: runtime.onError });
    svc.automation.register('flow.wake', runtime.wake);
    onConversationCancel(db, runtime.onCancel);

    // ---- entrada
    const text = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
    const revisionOf = input => {
      if (!Number.isInteger(input?.expectedRevision))
        throw fail(400, 'Falta expectedRevision: recarga el recorrido.', { code: 'invalid_request' });
      return input.expectedRevision;
    };
    function cleanName(value, fallback = null) {
      const name = text(value, 81);
      if (!name) {
        if (fallback !== null) return fallback;
        throw fail(400, 'Escribe el nombre del recorrido.', { code: 'invalid_request', field: 'name' });
      }
      if (name.length > 80)
        throw fail(400, 'El nombre admite hasta 80 caracteres.', { code: 'invalid_request', field: 'name' });
      return name;
    }
    // El grafo se guarda en su forma canónica (repairGraph) y dentro de los límites del modelo.
    function cleanGraph(value) {
      if (value === undefined || value === null) return emptyGraph();
      let bytes = 0;
      try {
        bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
      } catch {
        throw fail(400, 'El recorrido no se puede guardar: no son datos simples.', { code: 'flow_invalid' });
      }
      if (bytes > LIMITS.bytes)
        throw fail(413, `El recorrido ocupa demasiado: el máximo es ${Math.floor(LIMITS.bytes / 1000)} KB.`, {
          code: 'flow_limit',
        });
      const graph = repairGraph(value).graph;
      if (graph.nodes.length > LIMITS.nodes)
        throw fail(400, `El recorrido admite hasta ${LIMITS.nodes} pasos.`, { code: 'flow_limit' });
      if (graph.edges.length > LIMITS.edges)
        throw fail(400, `El recorrido admite hasta ${LIMITS.edges} conexiones.`, { code: 'flow_limit' });
      return graph;
    }
    function cleanStart(value) {
      const type = Object.hasOwn(START_TYPES, value?.type) ? value.type : 'manual';
      if (type !== 'keyword') return { type };
      const words = [
        ...new Set((Array.isArray(value.keywords) ? value.keywords : []).map(w => text(w, 61)).filter(Boolean)),
      ];
      if (words.some(w => w.length > 60))
        throw fail(400, 'Cada palabra clave admite hasta 60 caracteres.', { code: 'invalid_request', field: 'start' });
      if (words.length > 30)
        throw fail(400, 'Un recorrido admite hasta 30 palabras clave.', { code: 'invalid_request', field: 'start' });
      return { type, keywords: words, mode: KEYWORD_MODES.includes(value.mode) ? value.mode : 'contains' };
    }
    const startProblems = start =>
      start.type === 'keyword' && !start.keywords.length
        ? [{ code: 'start', message: 'Escribe al menos una palabra clave para iniciar el recorrido.' }]
        : [];

    // Problemas del borrador: los del modelo compartido con las listas reales de la marca, más los tipos de paso que
    // este servidor todavía no ejecuta y el inicio.
    // Las plantillas de WhatsApp de la marca (módulo wa-templates). Sin el módulo, ninguna: un paso de plantilla se
    // rechaza al publicar como «no existe en esta marca» en lugar de pasar sin comprobar.
    const waTemplatesOf = brandId => {
      try {
        return host.module('wa-templates').flowTemplates(brandId);
      } catch {
        return [];
      }
    };
    function issuesOf(brandId, flowId, graph, settings, start) {
      const lists = { ...repo.validationLists(brandId), waTemplates: waTemplatesOf(brandId) };
      let attributes = [];
      try {
        attributes = host
          .module('attributes')
          .definitions(brandId, { archived: true })
          .map(d => ({
            key: d.key,
            label: d.label,
            type: d.type,
            status: d.status,
          }));
      } catch {
        attributes = undefined;
      }
      const ctx = {
        ...lists,
        attributes,
        settings,
        flowId,
        ai: false,
      };
      const result = validateGraph(graph, ctx);
      const errors = [
        ...result.errors,
        ...validateSettings(settings, ctx),
        ...unsupportedProblems(graph, ctx),
        ...startProblems(start),
      ];
      return { errors, warnings: result.warnings };
    }

    // ---- vistas
    function counts(brandId, flowId) {
      const out = { sessions: 0, inProgress: 0, completed: 0, handoff: 0, left: 0, dropped: 0, excluded: 0 };
      const category = {
        completed: 'completed',
        assistant: 'completed',
        replaced: 'completed',
        handoff: 'handoff',
        human_takeover: 'handoff',
        closed: 'handoff',
        left: 'left',
        timeout: 'dropped',
        opt_out: 'dropped',
        window_closed: 'dropped',
      };
      for (const row of repo.counts(brandId, flowId)) {
        out.sessions += row.n;
        if (row.state !== 'ended') out.inProgress += row.n;
        else out[category[row.outcome] || 'excluded'] += row.n;
      }
      return out;
    }
    const summary = f => ({
      id: f.id,
      brandId: f.brand_id,
      name: f.name,
      description: f.description,
      status: f.status,
      start: f.start,
      revision: f.revision,
      publishedVersion: f.published_version,
      publishedAt: repo.publishedAt(f.brand_id, f.id, f.published_version),
      updatedAt: f.updated_at,
      createdAt: f.created_at,
      metrics: counts(f.brand_id, f.id),
    });
    // ¿Atienden los recorridos de la marca? La misma regla que el motor (runtime.brandSpeaks); el motivo, en palabras,
    // con dónde se enciende. «WhatsApp real apagado» es sólo información: en el laboratorio sí atiende.
    const WHERE = 'Operación → Ventas y cobro → Seguimientos';
    function attendingOf(brandId) {
      const ok = runtime.brandSpeaks(brandId);
      const info = isRealBrand(db, brandId)
        ? null
        : 'El modo real de esta marca está apagado: lo que envían los recorridos lleva los avisos de prueba («Chat de prueba…», «Pago de prueba…»), también por WhatsApp real. Se enciende en Operación → Ventas y cobro → Pagos → Modo real.';
      if (ok) return { ok, reason: null, label: 'La marca está atendiendo con recorridos.', where: null, info };
      const [reason, label] = repo.globalPaused()
        ? ['automation_paused', 'La automatización está en pausa para todas las marcas.']
        : !repo.automationEnabled(brandId)
          ? ['automation_off', 'La automatización de la marca está apagada.']
          : [
              'assistant_mode',
              'El asistente de la marca no responde solo (su nivel es «Apagado» o «Sugerir al asesor»): debe ser «Responder con plantillas» o «Autónomo con IA».',
            ];
      const where =
        reason === 'assistant_mode'
          ? WHERE + ' → Respuestas automáticas a clientes → Nivel de respuestas'
          : reason === 'automation_paused'
            ? WHERE + ' → Automatización (quitar la pausa global)'
            : WHERE + ' → Automatización (activar la marca)';
      return { ok, reason, label, where, info };
    }
    const full = f => ({ ...summary(f), graph: f.draft, settings: normalizeSettings(f.settings) });
    const sessionView = row =>
      row && {
        id: row.id,
        flowId: row.flow_id,
        version: row.flow_version,
        conversationId: row.conversation_id,
        state: row.state,
        nodeId: row.node_id,
        waiting: row.waiting ? { kind: row.waiting.kind, nodeId: row.waiting.nodeId } : null,
        steps: row.steps,
        outcome: row.outcome,
        startedBy: row.started_by,
        expiresAt: row.expires_at,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        endedAt: row.ended_at,
      };

    // ---- localizar con alcance por marca
    function locate(user, id, perm) {
      const brandId = repo.brandOf(id);
      if (!brandId) throw fail(404, 'Recorrido no disponible.', { code: 'not_found' });
      access.require(user, perm, brandId);
      return repo.flow(brandId, id);
    }
    const stale = () =>
      fail(409, 'Alguien más guardó este recorrido. Recárgalo para ver sus cambios.', { code: 'stale_record' });

    // ---- escrituras (todas en una transacción síncrona, sin red)
    function create(user, input) {
      const brandId = text(input.brandId, 64);
      access.require(user, 'automation.manage', brandId);
      const clientRef = input.clientRef;
      if (typeof clientRef !== 'string' || !REF.test(clientRef))
        throw fail(400, 'Falta clientRef.', { code: 'invalid_request', field: 'clientRef' });
      return host.transaction(db, () => {
        const existing = repo.flowByRef(brandId, clientRef);
        if (existing) return { flow: existing, duplicate: true };
        if (repo.count(brandId) >= LIMITS.flowsPerBrand)
          throw fail(409, `Una marca admite hasta ${LIMITS.flowsPerBrand} recorridos.`, { code: 'flow_limit' });
        let graph, settings, start;
        if (input.fromFlowId) {
          const from = repo.flow(brandId, text(input.fromFlowId, 64));
          if (!from) throw fail(404, 'El recorrido que quieres copiar no está disponible.', { code: 'not_found' });
          ({ draft: graph, settings, start } = from);
        } else {
          graph = cleanGraph(input.graph);
          settings = normalizeSettings(input.settings);
          start = cleanStart(input.start);
        }
        const id = randomUUID();
        const at = now();
        repo.insertFlow(brandId, {
          id,
          name: cleanName(input.name),
          description: text(input.description, 300),
          draft: graph,
          settings,
          start,
          clientRef,
          userId: user.id,
          at,
        });
        return { flow: repo.flow(brandId, id), duplicate: false };
      });
    }

    function saveDraft(user, id, input) {
      const f = locate(user, id, 'automation.manage');
      if (f.status === 'archived') throw fail(409, 'El recorrido está archivado.', { code: 'flow_archived' });
      const expected = revisionOf(input);
      const fields = {};
      if (input.graph !== undefined) fields.draft = cleanGraph(input.graph);
      if (input.settings !== undefined) fields.settings = normalizeSettings(input.settings);
      if (input.start !== undefined) fields.start = cleanStart(input.start);
      if (input.name !== undefined) fields.name = cleanName(input.name);
      if (input.description !== undefined) fields.description = text(input.description, 300);
      return host.transaction(db, () => {
        if (!repo.updateFlow(f.brand_id, id, expected, fields, user.id, now())) throw stale();
        return repo.flow(f.brand_id, id);
      });
    }

    function publish(user, id, input) {
      const f = locate(user, id, 'automation.manage');
      if (f.status === 'archived') throw fail(409, 'El recorrido está archivado.', { code: 'flow_archived' });
      const expected = revisionOf(input);
      const issues = issuesOf(f.brand_id, f.id, f.draft, f.settings, f.start);
      if (issues.errors.length)
        throw fail(422, 'El recorrido tiene problemas que impiden publicarlo.', {
          code: 'flow_invalid',
          details: { issues },
        });
      return host.transaction(db, () => {
        const current = repo.flow(f.brand_id, id);
        if (current.revision !== expected) throw stale();
        const version = repo.lastVersion(f.brand_id, id) + 1;
        const at = now();
        repo.insertVersion(f.brand_id, {
          flowId: id,
          version,
          name: current.name,
          graph: current.draft,
          settings: normalizeSettings(current.settings),
          start: current.start,
          note: text(input.note, 300),
          userId: user.id,
          at,
        });
        if (!repo.updateFlow(f.brand_id, id, expected, { published_version: version }, user.id, at)) throw stale();
        return { flow: repo.flow(f.brand_id, id), version };
      });
    }

    function setStatus(user, id, input, to) {
      const f = locate(user, id, 'automation.manage');
      const expected = revisionOf(input);
      if (f.status === 'archived' && to !== 'archived')
        throw fail(409, 'El recorrido está archivado.', { code: 'flow_archived' });
      if (to === 'active' && f.published_version === null)
        throw fail(409, 'Publica el recorrido antes de activarlo.', { code: 'flow_unpublished' });
      return host.transaction(db, () => {
        if (!repo.updateFlow(f.brand_id, id, expected, { status: to }, user.id, now())) throw stale();
        // Pausar deja terminar las conversaciones en curso, salvo que se pida detenerlas; archivar las detiene.
        const stop =
          to === 'archived' ? 'flow_archived' : to === 'paused' && input.stopSessions === true ? 'stopped' : null;
        const stopped = stop ? repo.endFlowSessions(f.brand_id, id, stop, now()).length : 0;
        return { flow: repo.flow(f.brand_id, id), stopped };
      });
    }

    function duplicate(user, id, input) {
      const f = locate(user, id, 'automation.manage');
      return create(user, {
        brandId: f.brand_id,
        name: input.name ? input.name : (f.name + ' (copia)').slice(0, 80),
        description: f.description,
        fromFlowId: f.id,
        clientRef: input.clientRef,
      });
    }

    // ---- simulador: el mismo motor con un `io` que sólo anota. No escribe ni envía nada.
    async function simulate(user, id, input) {
      const f = locate(user, id, 'inbox.view');
      const brandId = f.brand_id;
      let graph, settings;
      if (Number.isInteger(input.version)) {
        const v = repo.version(brandId, id, input.version);
        if (!v) throw fail(404, 'Versión no disponible.', { code: 'not_found' });
        ({ graph, settings } = v);
      } else if (input.graph !== undefined || input.settings !== undefined) {
        // Un grafo sin guardar: lo prueba quien puede editar recorridos y pasa por la misma validación que publicar.
        access.require(user, 'automation.manage', brandId);
        graph = input.graph !== undefined ? cleanGraph(input.graph) : f.draft;
        settings = normalizeSettings(input.settings !== undefined ? input.settings : f.settings);
        const issues = issuesOf(brandId, f.id, graph, settings, f.start);
        if (issues.errors.length)
          throw fail(422, 'El recorrido tiene problemas: corrígelos antes de probarlo.', {
            code: 'flow_invalid',
            details: { issues },
          });
      } else {
        graph = f.draft;
        settings = normalizeSettings(f.settings);
      }
      const brandLists = repo.validationLists(brandId);
      const courses = brandLists.courses;
      const courseId = courses.some(k => k.id === input.courseId) ? input.courseId : courses[0]?.id || null;
      const channel = ['whatsapp', 'instagram', 'facebook'].includes(input.channel) ? input.channel : 'whatsapp';
      const conv = {
        id: 'simulacion',
        brand_id: brandId,
        course_id: courseId,
        edition_id: null,
        channel,
        customer_id: user.id,
        status: 'open',
        bot_enabled: 1,
      };
      const messages = [];
      const trace = [];
      const notes = [];
      const sim = s => {
        const card = kind => {
          if (!courseId) return { reason: 'La marca no tiene cursos' };
          try {
            const info = svc.catalogue.info(courseId);
            if (info.reason) return { reason: info.reason };
            return { ctx: info, prepared: svc.catalogue.prepare(conv, { kind }) };
          } catch (error) {
            return { reason: String(error?.message || 'No disponible').replace(/\.$/, '') };
          }
        };
        return {
          copy: { ...copy, invalidAnswer: 'No logré entender tu respuesta. ¿Me la escribes de nuevo, por favor?' },
          values() {
            try {
              const info = svc.catalogue.info(courseId);
              return { base: { ...templateValues(info, ''), nombre: '' }, contacto: {} };
            } catch {
              return { base: {}, contacto: {} };
            }
          },
          conditionRecord: () => ({
            attr: {},
            tags: [],
            course: courseId,
            channel,
            open: isOpen(now(), svc.operations.settings(brandId)),
            clock: null,
          }),
          send({
            text: body,
            buttons = null,
            prepared = null,
            order = false,
            list = null,
            file = null,
            template = null,
          }) {
            if (template) {
              messages.push({
                from: 'flow',
                nodeId: s.nodeId,
                text: template.text,
                buttons: template.buttons?.length ? template.buttons : null,
                template: template.name,
              });
              return null;
            }
            const t = order ? body.replace('{{pedido}}', '[aquí iría el pedido con su enlace de pago]') : body;
            messages.push({
              from: 'flow',
              nodeId: s.nodeId,
              text: forBrand(db, brandId, t),
              buttons,
              flyer: Boolean(prepared?.flyerSnapshot),
              ...(file ? { media: file.name } : {}),
              ...(list
                ? {
                    list: {
                      button: list.button,
                      sections: list.sections.map(sec => ({
                        title: sec.title,
                        rows: sec.rows.map(r => ({ title: r.title, description: r.description })),
                      })),
                    },
                  }
                : {}),
            });
            return null;
          },
          // Los mismos archivos que el motor real: de la biblioteca de ESTA marca y de un tipo admitido.
          file(fileId) {
            const f = repo.libraryFile(brandId, String(fileId || ''));
            if (!f) return { reason: 'El archivo ya no está en la biblioteca de la marca' };
            if (!FLOW_FILE_MIMES.includes(f.mime)) return { reason: 'El archivo no es una imagen JPG o PNG ni un PDF' };
            return { id: f.id, name: f.filename, mime: f.mime };
          },
          // Una plantilla sólo sale por WhatsApp real: en la prueba se muestra con datos de ejemplo y no se envía.
          template(templateId) {
            if (channel !== 'whatsapp')
              return {
                reason: 'Una plantilla de WhatsApp no sale por ' + (channel === 'instagram' ? 'Instagram' : 'Facebook'),
              };
            const found = waTemplatesOf(brandId).find(t => t.id === templateId && t.status === 'approved');
            if (!found) return { reason: 'La plantilla de WhatsApp ya no está aprobada para esta marca' };
            let text = '';
            try {
              const api = host.module('wa-templates');
              const course = courses.find(k => k.id === courseId)?.title || '';
              const r = api.resolve(repo.waTemplate(brandId, templateId), {
                values: { nombre: 'Ana', curso: course, edicion: course, marca: repo.brandName(brandId) },
              });
              text = r.text;
            } catch {
              text = '';
            }
            notes.push(
              `Saldría la plantilla de WhatsApp «${found.name}» (sólo por un número real; en la prueba no se envía).`,
            );
            return { name: found.name, text, buttons: found.buttons, category: found.category };
          },
          windowOpen: () => true,
          stop: () => null,
          catalogue: card,
          material(templateId) {
            try {
              const prepared = svc.catalogue.prepare(conv, { templateId });
              return { text: prepared.text, prepared };
            } catch (error) {
              return { reason: String(error?.message || 'No disponible').replace(/\.$/, '') };
            }
          },
          enroll() {
            const c = card('flyer');
            if (c.reason) return { reason: c.reason };
            return svc.payments.settings(brandId).enabled
              ? { kind: 'order', text: copy.enrollWithOrder(c.ctx, '') }
              : { kind: 'manual', text: copy.enrollWithAdvisor(c.ctx, '') };
          },
          stage: stage => notes.push(`La etapa comercial pasaría a «${stage}».`),
          setAttribute: (key, value) => notes.push(`Guardaría el dato «${key}»: ${String(value).slice(0, 80)}.`),
          tags: (add, remove) => notes.push(`Etiquetas: +${add.length} / −${remove.length}.`),
          // En la prueba no se inscribe a nadie: sólo se dice qué pasaría.
          sequence(sequenceId) {
            const found = brandLists.sequences.find(x => x.id === sequenceId && !x.archived);
            if (!found) {
              notes.push('La secuencia elegida ya no está disponible: nadie entraría y el recorrido seguiría.');
              return { refused: 'sequence_off' };
            }
            notes.push(
              found.enabled
                ? `Aquí la persona entraría a la secuencia «${found.name}» (en la prueba no se inscribe a nadie).`
                : `Aquí la persona entraría a la secuencia «${found.name}», pero está apagada: hoy no entraría nadie y el recorrido seguiría.`,
            );
            return found.enabled ? { enrolled: true } : { refused: 'sequence_off' };
          },
          lastMessageText: () => input.input?.text || '',
          schedule(kind, at) {
            if (kind === 'delay') notes.push(`Esperaría ${Math.round((at - now()) / 1000)} s.`);
          },
          log: (event, d = {}) =>
            trace.push({ event, nodeId: d.nodeId ?? null, port: d.port ?? null, detail: d.detail ?? null }),
        };
      };
      const io = { current: null };
      const env = makeEnv({ graph, settings, io: null, now: now() });
      // Del estado que devuelve el navegador sólo se toma lo mínimo: el paso en el que va, las variables (acotadas) y
      // los contadores. Lo que espera ese paso (opciones, tipo de respuesta, expresión) se vuelve a armar desde el
      // grafo, nunca desde lo que mande el cliente.
      let s = null;
      if (input.state && typeof input.state === 'object') {
        const given = input.state;
        const nodeId = typeof given.nodeId === 'string' ? given.nodeId : '';
        const waitingNode = env.byId.get(nodeId);
        const count = v => Math.min(Math.max(Number.isInteger(v) ? v : 0, 0), 3);
        const waiting = waitingNode
          ? waitOf(waitingNode, env, { misses: count(given.waiting?.misses), tries: count(given.waiting?.tries) })
          : null;
        if (!waiting)
          throw fail(400, 'El estado de la prueba no es válido: vuelve a empezar.', { code: 'invalid_request' });
        const vars = {};
        const entries = given.vars && typeof given.vars === 'object' ? Object.entries(given.vars) : [];
        for (const [key, value] of entries.slice(0, LIMITS.variables))
          if (VARIABLE_RE.test(key) && ['string', 'number'].includes(typeof value))
            vars[key] = String(value).slice(0, LIMITS.value);
        s = newSession({ id: 'simulacion', flowId: id, version: 0, graph: env.graph, now: now(), vars });
        Object.assign(s, {
          nodeId,
          state: 'waiting',
          waiting,
          seq: Math.min(Math.max(Number.isInteger(given.seq) ? given.seq : 0, 0), CAPS.perSession),
          steps: Math.min(Math.max(Number.isInteger(given.steps) ? given.steps : 0, 0), CAPS.perSession),
          expiresAt: null,
        });
      }
      const bind = session => {
        io.current = sim(session);
        env.io = io.current;
      };
      if (!s) {
        s = newSession({ id: 'simulacion', flowId: id, version: 0, graph: env.graph, now: now() });
        bind(s);
        advance(s, env);
      } else {
        bind(s);
        const said = String(input.input?.text ?? '').slice(0, 2000);
        const chosen = s.waiting?.options?.find(o => o.id === input.input?.optionId);
        const message = { text: chosen ? chosen.label : said };
        if (!message.text)
          throw fail(400, 'Escribe lo que diría la persona o elige una opción.', { code: 'invalid_request' });
        messages.push({ from: 'person', text: message.text });
        const r = route(s, env, message, svc.replies.classify);
        // Igual que el motor: la palabra clave del propio recorrido, escrita mientras se espera una respuesta, lo
        // empieza de nuevo (sólo si puede repetirse «siempre»).
        const restarts =
          r.kind === 'detour' &&
          f.start?.type === 'keyword' &&
          (settings.reentry ?? 'always') === 'always' &&
          keywordMatch(message.text, f.start.keywords || [], { mode: f.start.mode || 'contains' }) !== null;
        if (restarts) {
          notes.push('La persona escribió otra vez la palabra clave: el recorrido empieza de nuevo.');
          s = newSession({ id: 'simulacion', flowId: id, version: 0, graph: env.graph, now: now() });
          bind(s);
          advance(s, env);
        } else if (['detour', 'intent', 'interrupt', 'during_delay', 'expired'].includes(r.kind)) {
          const answer = await svc.replies.test(user, {
            brandId,
            courseId,
            text: message.text,
            channel,
          });
          // Una lista no se vuelve a ofrecer como botones (no caben): sigue a la vista en el chat, como en el motor.
          const reoffer =
            !s.waiting?.list &&
            ((r.kind === 'detour' && env.settings.reofferOnDetour) || (r.kind === 'intent' && r.stay));
          if (r.kind === 'intent') rememberChoice(s, s.waiting, r.option);
          messages.push({
            from: 'assistant',
            text: answer.reply,
            buttons: reoffer ? s.waiting.options.map(o => o.label) : answer.buttons,
            reason: answer.reason,
          });
          if (r.kind === 'detour') {
            s.waiting.misses = (s.waiting.misses || 0) + 1;
            if (s.waiting.misses >= env.settings.maxMisses) {
              Object.assign(s, { state: 'ended', outcome: 'left', waiting: null });
            }
          } else if (r.kind === 'interrupt') Object.assign(s, { state: 'ended', outcome: 'handoff', waiting: null });
          else if (r.kind === 'intent' && !r.stay)
            Object.assign(s, { state: 'ended', outcome: 'assistant', waiting: null });
          else if (r.kind === 'expired') Object.assign(s, { state: 'ended', outcome: 'timeout', waiting: null });
        } else feed(s, env, r);
      }
      // Las esperas no se duermen: el simulador sigue de largo y lo anota.
      for (let i = 0; i < 10 && s.state === 'delayed'; i += 1) {
        const node = env.byId.get(s.nodeId);
        const to = node?.type === 'delay' ? env.target(s.nodeId, 'next') : s.nodeId;
        s.waiting = null;
        if (!to) Object.assign(s, { state: 'ended', outcome: 'completed' });
        else {
          s.nodeId = to;
          s.state = 'running';
          advance(s, env);
        }
      }
      return {
        messages,
        state: s,
        trace,
        waiting:
          s.state === 'waiting'
            ? {
                kind: s.waiting.kind,
                nodeId: s.waiting.nodeId,
                options: s.waiting.options || null,
                ...(s.waiting.list ? { list: true } : {}),
              }
            : null,
        ended: s.state === 'ended',
        outcome: s.outcome,
        notes,
      };
    }

    // ---- listas de la marca para el editor (lo que ofrecen sus menús y contra lo que valida mientras se arma)
    function editorLists(brandId) {
      const lists = repo.validationLists(brandId);
      let attributes = [];
      try {
        attributes = host
          .module('attributes')
          .definitions(brandId, { archived: false })
          .map(d => ({ key: d.key, label: d.label, type: d.type, status: d.status }));
      } catch {
        attributes = [];
      }
      return {
        brand: { id: brandId, name: repo.brandName(brandId) },
        courses: lists.courses,
        materials: lists.materials,
        tags: lists.tags,
        users: lists.users,
        flows: lists.flows,
        files: lists.files,
        sequences: lists.sequences.filter(s => !s.archived),
        waTemplates: waTemplatesOf(brandId),
        realWhatsApp: lists.realWhatsApp,
        attributes,
      };
    }

    // ---- subir un archivo a la biblioteca de la marca desde el editor (la subida única: server/lib/upload.mjs).
    // Fuera de transacción se comprueba, se guarda en el disco y después se registra; si el registro falla, el archivo
    // se borra. Un mismo clientRef de la misma persona no sube dos veces.
    const uploads = new Map();
    async function uploadFile(user, input) {
      const brandId = text(input.brandId, 64);
      access.require(user, 'automation.manage', brandId);
      const clientRef = input.clientRef;
      if (typeof clientRef !== 'string' || !REF.test(clientRef))
        throw fail(400, 'Falta clientRef.', { code: 'invalid_request', field: 'clientRef' });
      const key = user.id + ':' + clientRef;
      if (uploads.has(key)) return { file: uploads.get(key), duplicate: true };
      const file = receive(input.file, { allow: ['image', 'document'], mimes: [...FLOW_FILE_MIMES] });
      const storageName = await store(host.dataDir, { area: 'library', brandId }, file);
      const id = randomUUID();
      try {
        host.transaction(db, () => {
          access.require(user, 'automation.manage', brandId);
          repo.insertFile(brandId, {
            id,
            filename: file.filename,
            mime: file.mime,
            size: file.size,
            storageName,
            userId: user.id,
            at: now(),
          });
        });
      } catch (error) {
        await discard(host.dataDir, 'library', storageName);
        throw error;
      }
      const out = { id, name: file.filename, mime: file.mime, size: file.size };
      uploads.set(key, out);
      if (uploads.size > 500) uploads.delete(uploads.keys().next().value);
      return { file: out, duplicate: false };
    }

    // ---- rendimiento por paso (analytics.mjs): por versión (la publicada por omisión) y periodo
    function performance(f, params) {
      const raw = params.get('version');
      const version = raw === 'all' ? null : /^\d{1,6}$/.test(raw || '') ? Number(raw) : (f.published_version ?? null);
      const num = name => (params.get(name) === null ? undefined : Number(params.get(name)));
      const days = num('days');
      const period = periodOf(
        { from: num('from'), to: num('to'), days: Number.isInteger(days) ? days : undefined },
        now(),
      );
      return {
        flowId: f.id,
        publishedVersion: f.published_version,
        versions: analytics.versions(f.brand_id, f.id).map(v => ({ version: v.version, sessions: v.n })),
        ...analytics.compute(f.brand_id, f.id, { version, period }),
      };
    }

    // ---- sugerencias: reglas siempre; IA si está configurada y el tope lo permite. Fuera de toda transacción.
    async function suggest(f, input) {
      const params = new URLSearchParams();
      if (Number.isInteger(input.days)) params.set('days', String(input.days));
      const stats = performance(f, params);
      const outline = outlineOf(f.draft, stats.nodes);
      const rules = ruleSuggestions(outline).map(x => ({ ...x, source: 'rules' }));
      const provider = svc.aiProvider;
      const ai = provider?.reviewFlow
        ? await provider.reviewFlow({ brand: repo.brandName(f.brand_id), outline })
        : { available: false, reason: 'La IA no está configurada en este CRM.' };
      const fromAi = ai.available ? cleanSuggestions(ai.suggestions, outline).map(x => ({ ...x, source: 'ai' })) : [];
      return {
        ai: {
          available: Boolean(ai.available),
          reason: ai.reason || null,
          budget: Boolean(ai.budget),
          model: ai.model || null,
        },
        suggestions: [...fromAi, ...rules].map(x => ({ ...x, kindLabel: REVIEW_KINDS[x.kind] || REVIEW_KINDS.other })),
        sent: { steps: outline.length, withStats: outline.filter(s => s.stats).length },
      };
    }

    // ---- rutas
    const PREFIX = '/api/chatflows';
    async function handle(req, res, path, user, url) {
      if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
      const method = req.method;
      let m;
      if (path === PREFIX && method === 'GET') {
        const brand = url.searchParams.get('brand');
        // Las marcas que la persona puede ver van SIEMPRE completas, aunque pida los recorridos de una sola: con
        // ellas la pantalla pinta el selector de marca, y si se acortaran al elegir una, el selector desaparecería.
        const visible = access.brandIds(user, 'inbox.view');
        let brandIds;
        if (brand) {
          access.require(user, 'inbox.view', brand);
          brandIds = [brand];
        } else {
          brandIds = visible;
          if (!brandIds.length) access.require(user, 'inbox.view');
        }
        const archived = url.searchParams.get('archived') === '1';
        host.json(res, 200, {
          flows: repo.flows(brandIds, { archived }).map(summary),
          limits: { ...LIMITS, ...CAPS },
          startTypes: START_TYPES,
          // Para la pantalla: las marcas que ve, si puede editar en cada una y los tipos de paso no disponibles.
          brands: (visible.length ? visible : brandIds).map(brandId => ({
            id: brandId,
            name: repo.brandName(brandId),
            canManage: access.can(user, 'automation.manage', brandId),
            attending: attendingOf(brandId),
          })),
          unavailable: UNAVAILABLE_TYPES,
        });
        return true;
      }
      if (path === PREFIX + '/lists' && method === 'GET') {
        const brandId = text(url.searchParams.get('brand'), 64);
        access.require(user, 'inbox.view', brandId);
        host.json(res, 200, { lists: editorLists(brandId) });
        return true;
      }
      if (path === PREFIX + '/files' && method === 'POST') {
        host.rate('chatflows.upload:' + user.id, 20);
        const r = await uploadFile(user, (await host.body(req)) ?? {});
        if (!r.duplicate) host.audit(user, 'chatflow.file', r.file.id);
        host.json(res, r.duplicate ? 200 : 201, r);
        return true;
      }
      if (path === PREFIX && method === 'POST') {
        const input = (await host.body(req)) ?? {};
        const r = create(user, input);
        if (!r.duplicate) {
          host.audit(user, 'chatflow.created', r.flow.id);
          emit(r.flow.brand_id, { flowId: r.flow.id, kind: 'created' });
        }
        host.json(res, r.duplicate ? 200 : 201, { flow: full(r.flow), duplicate: r.duplicate });
        return true;
      }
      if ((m = path.match(new RegExp(`^${PREFIX}/conversations/(${ID})$`)))) {
        const c = host.accessConversation(m[1], user);
        if (method === 'GET') {
          access.require(user, 'inbox.view', c.brand_id);
          host.json(res, 200, { session: sessionView(repo.activeSession(c.brand_id, c.id)) ?? null });
          return true;
        }
        access.require(user, 'inbox.reply', c.brand_id);
        if (method === 'POST') {
          const input = (await host.body(req)) ?? {};
          if (typeof input.clientRef !== 'string' || !REF.test(input.clientRef))
            throw fail(400, 'Falta clientRef.', { code: 'invalid_request', field: 'clientRef' });
          const r = host.transaction(db, () => {
            const fresh = repo.conversation(c.brand_id, c.id);
            const existing = repo.sessionBySource(c.brand_id, 'manual:' + input.clientRef);
            if (existing) return { session: existing, duplicate: true };
            if (!runtime.automatable(fresh))
              throw fail(409, 'El recorrido sólo inicia con el asistente a cargo de la conversación y abierta.', {
                code: 'not_automatable',
              });
            if (!runtime.brandSpeaks(c.brand_id))
              throw fail(409, 'La automatización de la marca está apagada o su asistente no responde solo.', {
                code: 'automation_off',
              });
            const w = svc.channel.windowOf(fresh);
            if (w.enforced && !w.open)
              throw fail(409, 'La ventana de 24 horas está cerrada: el recorrido no puede escribir.', {
                code: 'window_closed',
              });
            if (repo.activeSession(c.brand_id, c.id))
              throw fail(409, 'Ya hay un recorrido en curso en esta conversación.', { code: 'session_active' });
            const flow = repo.published(c.brand_id, text(input.flowId, 64));
            if (!flow || flow.status !== 'active')
              throw fail(409, 'El recorrido no está publicado y activo.', { code: 'flow_unpublished' });
            return runtime.startManual(fresh, flow, input.clientRef);
          });
          if (!r.duplicate) host.audit(user, 'chatflow.started', r.session.id);
          host.broadcast('conversation', c.id);
          host.json(res, r.duplicate ? 200 : 201, { session: sessionView(r.session), duplicate: r.duplicate });
          return true;
        }
        if (method === 'DELETE') {
          const stopped = host.transaction(db, () => runtime.stopSession(c.brand_id, c.id));
          if (stopped) host.audit(user, 'chatflow.stopped', stopped.id);
          host.json(res, 200, { stopped: Boolean(stopped) });
          return true;
        }
        return false;
      }
      if (!(m = path.match(new RegExp(`^${PREFIX}/(${ID})(?:/(.+))?$`)))) return false;
      const [, id, rest = ''] = m;
      if (method === 'GET' && rest === '') {
        const f = locate(user, id, 'inbox.view');
        host.json(res, 200, {
          flow: full(f),
          versions: repo.versions(f.brand_id, f.id).map(v => ({
            version: v.version,
            name: v.name,
            note: v.note,
            publishedBy: v.published_by,
            publishedAt: v.published_at,
          })),
          issues: issuesOf(f.brand_id, f.id, f.draft, f.settings, f.start),
          canManage: access.can(user, 'automation.manage', f.brand_id),
          attending: attendingOf(f.brand_id),
        });
        return true;
      }
      if (method === 'GET' && rest === 'analytics') {
        const f = locate(user, id, 'inbox.view');
        host.json(res, 200, performance(f, url.searchParams));
        return true;
      }
      if (method === 'GET' && (m = rest.match(/^versions\/(\d{1,6})$/))) {
        const f = locate(user, id, 'inbox.view');
        const v = repo.version(f.brand_id, f.id, Number(m[1]));
        if (!v) throw fail(404, 'Versión no disponible.', { code: 'not_found' });
        host.json(res, 200, {
          version: {
            version: v.version,
            name: v.name,
            graph: v.graph,
            settings: v.settings,
            start: v.start,
            note: v.note,
            publishedBy: v.published_by,
            publishedAt: v.published_at,
          },
        });
        return true;
      }
      if (method === 'GET' && rest === 'sessions') {
        const f = locate(user, id, 'inbox.view');
        const state = ['active', 'ended'].includes(url.searchParams.get('state'))
          ? url.searchParams.get('state')
          : null;
        const before = Number(url.searchParams.get('before')) || null;
        const limit = Number(url.searchParams.get('limit')) || 50;
        host.json(res, 200, {
          sessions: repo.sessions(f.brand_id, f.id, { state, before, limit }).map(row => ({
            ...sessionView(row),
            customerName: row.customer_name,
          })),
        });
        return true;
      }
      if (method === 'GET' && (m = rest.match(new RegExp(`^sessions/(${ID})$`)))) {
        const f = locate(user, id, 'inbox.view');
        const row = repo.session(f.brand_id, m[1]);
        if (!row || row.flow_id !== f.id) throw fail(404, 'Sesión no disponible.', { code: 'not_found' });
        host.json(res, 200, { session: sessionView(row), events: repo.events(f.brand_id, row.id) });
        return true;
      }
      if (method === 'GET' && rest === 'log') {
        const f = locate(user, id, 'inbox.view');
        host.json(res, 200, { events: repo.flowLog(f.brand_id, f.id, Number(url.searchParams.get('limit')) || 100) });
        return true;
      }
      if (method === 'PUT' && rest === 'draft') {
        const input = (await host.body(req)) ?? {};
        const f = saveDraft(user, id, input);
        host.audit(user, 'chatflow.draft', id);
        emit(f.brand_id, { flowId: id, kind: 'draft' });
        host.json(res, 200, { flow: full(f), issues: issuesOf(f.brand_id, f.id, f.draft, f.settings, f.start) });
        return true;
      }
      if (method !== 'POST') return false;
      const input = (await host.body(req)) ?? {};
      if (rest === 'validate') {
        const f = locate(user, id, 'inbox.view');
        const graph = input.graph !== undefined ? cleanGraph(input.graph) : f.draft;
        const settings = input.settings !== undefined ? normalizeSettings(input.settings) : f.settings;
        const start = input.start !== undefined ? cleanStart(input.start) : f.start;
        const issues = issuesOf(f.brand_id, f.id, graph, settings, start);
        host.json(res, 200, { ok: !issues.errors.length, issues });
        return true;
      }
      if (rest === 'publish') {
        const r = publish(user, id, input);
        host.audit(user, 'chatflow.published', id);
        emit(r.flow.brand_id, { flowId: id, kind: 'published', version: r.version });
        host.json(res, 200, { flow: full(r.flow), version: r.version });
        return true;
      }
      const STATUS = { activate: 'active', pause: 'paused', archive: 'archived' };
      if (Object.hasOwn(STATUS, rest)) {
        const r = setStatus(user, id, input, STATUS[rest]);
        host.audit(user, 'chatflow.' + rest, id);
        emit(r.flow.brand_id, { flowId: id, kind: 'status', status: r.flow.status });
        host.json(res, 200, { flow: full(r.flow), stopped: r.stopped });
        return true;
      }
      if (rest === 'duplicate') {
        const r = duplicate(user, id, input);
        if (!r.duplicate) host.audit(user, 'chatflow.duplicated', r.flow.id);
        host.json(res, r.duplicate ? 200 : 201, { flow: full(r.flow), duplicate: r.duplicate });
        return true;
      }
      if (rest === 'suggestions') {
        const f = locate(user, id, 'automation.manage');
        host.rate('chatflows.suggest:' + user.id, 5);
        const r = await suggest(f, input);
        host.audit(user, 'chatflow.reviewed', id);
        host.json(res, 200, r);
        return true;
      }
      if (rest === 'simulate') {
        host.rate('chatflows.simulate:' + user.id, 60);
        host.json(res, 200, await simulate(user, id, input));
        return true;
      }
      return false;
    }

    return { handle, runtime, repo };
  },
};
