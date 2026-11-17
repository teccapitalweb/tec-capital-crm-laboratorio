// Reglas por mensaje (docs/PLAN_REGLAS.md; diseño de automatización §3.3, §3.7 y §5; conciliación, fila N-3).
//
// Una regla es «cuando un mensaje coincide con estas palabras y estas condiciones, haz estas acciones», sin dibujar un
// recorrido entero. Nace en borrador; encendida corre en el orden de la lista de su marca, después de un recorrido en
// curso y antes de un recorrido que arranca y del asistente (server/app/dispatch.mjs, ORDER). Todo nace apagado.
//
// Rutas (con sesión, bajo /api/rules). Lectura: equipo de la marca (inbox.view). Escritura: automation.manage.
//   GET   /api/rules                         {brands:[{id,name,canManage}]}
//   GET   /api/rules?brand=                  {brand, rules:[…], settings, attention, status, brands}
//   GET   /api/rules/lists?brand=            listas para el editor: etiquetas, cursos, materiales, recorridos, personas
//   POST  /api/rules                         {brandId, title, definition, clientRef} → 201 {rule} (en borrador, arriba)
//   GET   /api/rules/:id                     {rule}
//   PATCH /api/rules/:id                     {expectedRevision, title?, definition?} → {rule}
//   POST  /api/rules/:id/activate|pause|archive {expectedRevision} → {rule} · 409 rule_not_ready {issues}
//   GET   /api/rules/:id/runs?before=        {runs, nextBefore}
//   PUT   /api/rules/order                   {brandId, ids, expectedOrderRevision} → {orderRevision}
//   PATCH /api/rules/settings/:brandId       {expectedRevision, maxConsecutive} → {settings}
//   POST  /api/rules/test                    {brandId, text, channel?, courseId?, firstMessage?, tags?, hours?,
//                                             draft?:{ruleId?, title?, definition}} o {conversationId, text}
//                                             → {pipeline, rules, answeredBy, sent:false}. No escribe ni envía nada.
// Tiempo real v2: 'rules.changed' {brandId, data:{ruleId?}}.
import { randomUUID } from 'node:crypto';
import { ORDER } from '../../app/dispatch.mjs';
import {
  ACTIONS,
  CHANNELS,
  LIMIT_KINDS,
  LIMITS,
  MODES,
  STATUS_TARGETS,
  TRIGGERS,
  normalizeDefinition,
  referenceIssues,
  speaks,
  summary,
} from './definition.mjs';
import { REASONS, createRunner } from './runner.mjs';
import { createRepo } from './repo.mjs';

const PREFIX = '/api/rules';
const ID = /^[A-Za-z0-9-]{1,64}$/;
const REF = /^[A-Za-z0-9-]{8,100}$/;
const MODE_LABELS = Object.freeze({
  off: 'Apagado',
  suggest: 'Sugerir al asesor',
  templates: 'Responder con plantillas',
  autonomous: 'Autónomo con IA',
});
const START_LABELS = Object.freeze({
  first_message: 'con el primer mensaje',
  keyword: 'con una palabra clave',
  any_message: 'con cualquier mensaje',
  manual: 'sólo a mano',
});

export default {
  name: 'rules',
  create(host) {
    const { db, fail, access } = host;
    const svc = host.services;
    const repo = createRepo(db);
    const now = () => Date.now();
    const runner = createRunner({ host, repo, now });
    const emit = (brandId, data = {}) =>
      setImmediate(() => {
        try {
          host.realtime.emit('rules.changed', { brandId, data });
        } catch {
          /* el aviso en vivo es una cortesía: la pantalla vuelve a leer al entrar */
        }
      });

    // Cableado: el despachador del entrante. Si el motor entero fallara (cada regla ya corre en su SAVEPOINT), cede el
    // turno al siguiente del orden en lugar de saltar al asistente.
    host.dispatch?.register('rules', { order: ORDER.rules, inbound: runner.inbound, passOnError: true });

    // ---- entrada
    const text = (v, max) =>
      typeof v === 'string'
        ? v
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, max + 1)
        : '';
    const revisionOf = (input, key = 'expectedRevision') => {
      if (!Number.isInteger(input?.[key]))
        throw fail(400, 'Falta ' + key + ': recarga la lista de reglas.', { code: 'invalid_request', field: key });
      return input[key];
    };
    function cleanTitle(value) {
      const title = text(value, LIMITS.title);
      if (!title) throw fail(400, 'Escribe el nombre de la regla.', { code: 'invalid_request', field: 'title' });
      if (title.length > LIMITS.title)
        throw fail(400, `El nombre admite hasta ${LIMITS.title} caracteres.`, {
          code: 'invalid_request',
          field: 'title',
        });
      return title;
    }
    function cleanDefinition(value) {
      try {
        return normalizeDefinition(value);
      } catch (error) {
        throw fail(400, error.message, { code: 'rule_invalid', details: { problems: error.details?.problems ?? [] } });
      }
    }
    const stale = () =>
      fail(409, 'Alguien más guardó esta regla. Recárgala para ver sus cambios.', { code: 'stale_record' });
    const notReady = issues =>
      fail(409, 'La regla no se puede encender todavía: ' + issues[0], { code: 'rule_not_ready', details: { issues } });

    function locate(user, id, perm) {
      if (!ID.test(id)) throw fail(404, 'Regla no disponible.', { code: 'not_found' });
      const brandId = repo.brandOf(id);
      if (!brandId) throw fail(404, 'Regla no disponible.', { code: 'not_found' });
      access.require(user, perm, brandId);
      return repo.rule(brandId, id);
    }

    // ---- vistas
    const view = (r, lists = null) => {
      const def = r.definition;
      return {
        id: r.id,
        brandId: r.brand_id,
        title: r.title,
        status: r.status,
        position: r.position,
        revision: r.revision,
        executions: r.executions,
        lastRunAt: r.last_run_at,
        lastError: r.last_error,
        definition: def,
        summary: def ? summary(def) : { when: '', what: '' },
        speaks: def ? speaks(def) : false,
        issues: def && lists ? referenceIssues(def, lists) : [],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    };

    // ¿Quién atiende primero? El orden fijo del despachador con el estado real de la marca (diseño §3.7).
    function attention(brandId, rules) {
      const auto = svc.automation.enabledFor(brandId);
      const mode = svc.replies.settings(brandId).mode;
      const speaksNow = runner.brandSpeaks(brandId);
      const flows = repo.activeFlows(brandId);
      const active = rules.filter(r => r.status === 'active');
      const why = speaksNow
        ? null
        : repo.globalPaused()
          ? 'La automatización está en pausa para todas las marcas.'
          : !auto
            ? 'La automatización de la marca está apagada: no corren reglas ni recorridos.'
            : `El asistente está en «${MODE_LABELS[mode] ?? mode}»: las reglas y los recorridos sólo atienden con «Responder con plantillas» o «Autónomo con IA».`;
      return {
        status: { automation: auto, mode, modeLabel: MODE_LABELS[mode] ?? mode, speaks: speaksNow, why },
        steps: [
          {
            key: 'person',
            label: 'Una persona del equipo tomó el chat',
            detail: 'Mientras alguien atiende la conversación no contesta nada automático.',
            on: true,
          },
          {
            key: 'flow_in_progress',
            label: 'Un recorrido en curso',
            detail: 'Si la persona está a mitad de un recorrido, el recorrido toma su respuesta.',
            on: speaksNow && flows.length > 0,
          },
          {
            key: 'rules',
            label: 'Reglas por mensaje, en el orden de la lista',
            detail: active.length
              ? `${active.length} ${active.length === 1 ? 'regla encendida' : 'reglas encendidas'}: la primera que coincide y responde gana; las acciones silenciosas de las demás también corren.`
              : 'No hay reglas encendidas.',
            on: speaksNow && active.length > 0,
            items: active.map(r => ({ id: r.id, title: r.title })),
          },
          {
            key: 'flow_start',
            label: 'Un recorrido que arranca',
            detail: flows.length
              ? 'Si ninguna regla respondió, arranca el primero que aplique.'
              : 'No hay recorridos publicados y activos.',
            on: speaksNow && flows.length > 0,
            items: flows.map(f => ({ id: f.id, title: f.name, start: START_LABELS[f.start?.type] ?? '' })),
          },
          {
            key: 'assistant',
            label: 'El asistente de la marca',
            detail: `Contesta todo lo demás. Nivel actual: «${MODE_LABELS[mode] ?? mode}».`,
            on: auto && mode !== 'off',
          },
        ],
      };
    }

    function brandsFor(user) {
      return access.brandIds(user, 'inbox.view').map(id => ({
        id,
        name: repo.brandName(id),
        canManage: access.can(user, 'automation.manage', id),
      }));
    }

    // ---- escrituras (todas en una transacción síncrona, sin red)
    function create(user, input) {
      const brandId = text(input.brandId, 64);
      access.require(user, 'automation.manage', brandId);
      const clientRef = input.clientRef;
      if (typeof clientRef !== 'string' || !REF.test(clientRef))
        throw fail(400, 'Falta clientRef.', { code: 'invalid_request', field: 'clientRef' });
      const title = cleanTitle(input.title);
      const definition = cleanDefinition(input.definition);
      return host.transaction(db, () => {
        const existing = repo.ruleByRef(brandId, clientRef);
        if (existing) return { rule: existing, duplicate: true };
        if (repo.refTaken(clientRef)) throw fail(409, 'Referencia ya utilizada.', { code: 'client_ref_reused' });
        if (repo.count(brandId) >= LIMITS.rulesPerBrand)
          throw fail(409, `Una marca admite hasta ${LIMITS.rulesPerBrand} reglas.`, { code: 'rule_limit' });
        const id = randomUUID();
        const at = now();
        const min = repo.minPosition(brandId);
        repo.insertRule(brandId, {
          id,
          title,
          definition,
          position: min === null ? 0 : min - 1, // una regla nueva entra arriba (en borrador no corre)
          clientRef,
          userId: user.id,
          at,
        });
        repo.ensureSettings(brandId, at);
        repo.touchOrder(brandId, user.id, at);
        return { rule: repo.rule(brandId, id), duplicate: false };
      });
    }

    function update(user, id, input) {
      const r = locate(user, id, 'automation.manage');
      if (r.status === 'archived') throw fail(409, 'La regla está archivada.', { code: 'rule_archived' });
      const expected = revisionOf(input);
      const fields = {};
      if (input.title !== undefined) fields.title = cleanTitle(input.title);
      if (input.definition !== undefined) {
        fields.definition = cleanDefinition(input.definition);
        fields.trigger = fields.definition.trigger.type;
      }
      return host.transaction(db, () => {
        const current = repo.rule(r.brand_id, id);
        if (current.revision !== expected) throw stale();
        // Una regla encendida corre con lo que se guarda: debe poder ejecutarse.
        if (current.status === 'active' && fields.definition) {
          const issues = referenceIssues(fields.definition, repo.lists(r.brand_id));
          if (issues.length) throw notReady(issues);
        }
        if (!repo.updateRule(r.brand_id, id, expected, fields, user.id, now())) throw stale();
        return repo.rule(r.brand_id, id);
      });
    }

    function setStatus(user, id, input, to) {
      const r = locate(user, id, 'automation.manage');
      const expected = revisionOf(input);
      if (r.status === 'archived') throw fail(409, 'La regla está archivada.', { code: 'rule_archived' });
      return host.transaction(db, () => {
        const current = repo.rule(r.brand_id, id);
        if (current.revision !== expected) throw stale();
        if (to === 'active') {
          const issues = referenceIssues(current.definition, repo.lists(r.brand_id));
          if (issues.length) throw notReady(issues);
        }
        const at = now();
        if (!repo.updateRule(r.brand_id, id, expected, { status: to }, user.id, at)) throw stale();
        if (to === 'archived') {
          repo.ensureSettings(r.brand_id, at);
          repo.touchOrder(r.brand_id, user.id, at);
        }
        return repo.rule(r.brand_id, id);
      });
    }

    function reorder(user, input) {
      const brandId = text(input.brandId, 64);
      access.require(user, 'automation.manage', brandId);
      const expected = revisionOf(input, 'expectedOrderRevision');
      const ids = Array.isArray(input.ids) ? input.ids.filter(x => typeof x === 'string') : [];
      return host.transaction(db, () => {
        const rules = repo.rules(brandId);
        const current = new Set(rules.map(r => r.id));
        if (ids.length !== current.size || new Set(ids).size !== ids.length || ids.some(x => !current.has(x)))
          throw fail(409, 'La lista de reglas cambió mientras la ordenabas. Recárgala.', { code: 'stale_record' });
        const at = now();
        repo.ensureSettings(brandId, at);
        if (!repo.bumpOrder(brandId, expected, user.id, at))
          throw fail(409, 'Alguien más cambió el orden. Recarga la lista.', { code: 'stale_record' });
        ids.forEach((ruleId, i) => repo.setPosition(brandId, ruleId, i));
        return { orderRevision: repo.settings(brandId).orderRevision };
      });
    }

    function saveSettings(user, brandId, input) {
      access.require(user, 'automation.manage', brandId);
      let expected = revisionOf(input);
      const max = input.maxConsecutive;
      if (!Number.isInteger(max) || max < 1 || max > LIMITS.maxConsecutive)
        throw fail(400, `El tope de respuestas seguidas va de 1 a ${LIMITS.maxConsecutive}.`, {
          code: 'invalid_request',
          field: 'maxConsecutive',
        });
      return host.transaction(db, () => {
        const before = repo.settings(brandId);
        repo.ensureSettings(brandId, now());
        if (before.revision === 0 && expected === 0) expected = 1;
        if (!repo.saveSettings(brandId, expected, max, user.id, now()))
          throw fail(409, 'Alguien más cambió estos ajustes. Recárgalos.', { code: 'stale_record' });
        return repo.settings(brandId);
      });
    }

    // «Probar»: nunca escribe. Con una conversación real, también su estado (quién atiende, recorrido en curso).
    function test(user, input) {
      const sample = { text: typeof input.text === 'string' ? input.text.slice(0, 1000) : '' };
      if (!sample.text.trim())
        throw fail(400, 'Escribe un mensaje de prueba.', { code: 'invalid_request', field: 'text' });
      let brandId;
      if (input.conversationId) {
        const c = host.accessConversation(String(input.conversationId), user);
        brandId = c.brand_id;
        access.require(user, 'inbox.view', brandId);
        sample.conversation = c;
      } else {
        brandId = text(input.brandId, 64);
        access.require(user, 'inbox.view', brandId);
        const lists = repo.lists(brandId);
        if (input.courseId && !lists.courses.some(k => k.id === input.courseId))
          throw fail(400, 'El curso no es de esta marca.', { code: 'invalid_request', field: 'courseId' });
        if (Object.hasOwn(CHANNELS, input.channel)) sample.channel = input.channel;
        sample.courseId = input.courseId || null;
        sample.firstMessage = input.firstMessage === true;
        sample.hours = input.hours;
        sample.tags = Array.isArray(input.tags) ? input.tags.filter(t => lists.tags.some(x => x.id === t)) : [];
      }
      let override = null;
      if (input.draft) {
        access.require(user, 'automation.manage', brandId);
        const ruleId = typeof input.draft.ruleId === 'string' ? input.draft.ruleId : null;
        if (ruleId && repo.brandOf(ruleId) !== brandId) throw fail(404, 'Regla no disponible.', { code: 'not_found' });
        const saved = ruleId ? repo.rule(brandId, ruleId) : null;
        override = {
          id: ruleId || 'borrador',
          title: text(input.draft.title, LIMITS.title) || saved?.title || 'Regla sin guardar',
          revision: saved?.revision ?? 0,
          position: saved?.position ?? -Infinity,
          definition: cleanDefinition(input.draft.definition),
        };
      }
      return runner.explain(brandId, sample, { override });
    }

    function editorLists(brandId) {
      const lists = repo.lists(brandId);
      return {
        ...lists,
        materials: lists.materials.filter(m => m.status === 'approved'),
        flows: lists.flows.filter(f => f.published),
        actions: Object.entries(ACTIONS).map(([type, a]) => ({ type, label: a.label, kind: a.kind })),
        triggers: TRIGGERS,
        modes: MODES,
        limitKinds: LIMIT_KINDS,
        channels: CHANNELS,
        statuses: STATUS_TARGETS,
        limits: LIMITS,
      };
    }

    // ---- rutas
    async function handle(req, res, path, user, url) {
      host.requireStaff(user);
      const method = req.method;
      let m;
      if (path === PREFIX && method === 'GET') {
        const brand = url.searchParams.get('brand');
        const brands = brandsFor(user);
        if (!brand) {
          if (!brands.length) access.require(user, 'inbox.view');
          host.json(res, 200, { brands });
          return true;
        }
        access.require(user, 'inbox.view', brand);
        const rules = repo.rules(brand);
        const lists = repo.lists(brand);
        host.json(res, 200, {
          brand: { id: brand, name: repo.brandName(brand), canManage: access.can(user, 'automation.manage', brand) },
          brands,
          rules: rules.map(r => view(r, lists)),
          settings: repo.settings(brand),
          attention: attention(brand, rules),
          reasons: REASONS,
          limits: LIMITS,
        });
        return true;
      }
      if (path === PREFIX + '/lists' && method === 'GET') {
        const brandId = text(url.searchParams.get('brand'), 64);
        access.require(user, 'inbox.view', brandId);
        host.json(res, 200, { lists: editorLists(brandId) });
        return true;
      }
      if (path === PREFIX && method === 'POST') {
        const out = create(user, (await host.body(req)) ?? {});
        if (!out.duplicate) {
          host.audit(user, 'rule.created', out.rule.id);
          emit(out.rule.brand_id, { ruleId: out.rule.id });
        }
        host.json(res, out.duplicate ? 200 : 201, {
          rule: view(out.rule, repo.lists(out.rule.brand_id)),
          duplicate: out.duplicate,
        });
        return true;
      }
      if (path === PREFIX + '/order' && method === 'PUT') {
        const input = (await host.body(req)) ?? {};
        const out = reorder(user, input);
        host.audit(user, 'rule.order', text(input.brandId, 64));
        emit(text(input.brandId, 64));
        host.json(res, 200, out);
        return true;
      }
      if (path === PREFIX + '/test' && method === 'POST') {
        host.rate('rules.test:' + user.id, 60);
        host.json(res, 200, test(user, (await host.body(req)) ?? {}));
        return true;
      }
      if ((m = /^\/api\/rules\/settings\/([A-Za-z0-9_-]{1,64})$/.exec(path)) && method === 'PATCH') {
        const settings = saveSettings(user, m[1], (await host.body(req)) ?? {});
        host.audit(user, 'rule.settings', m[1]);
        emit(m[1]);
        host.json(res, 200, { settings });
        return true;
      }
      if ((m = /^\/api\/rules\/([A-Za-z0-9-]{1,64})$/.exec(path))) {
        if (method === 'GET') {
          const r = locate(user, m[1], 'inbox.view');
          host.json(res, 200, { rule: view(r, repo.lists(r.brand_id)) });
          return true;
        }
        if (method === 'PATCH') {
          const r = update(user, m[1], (await host.body(req)) ?? {});
          host.audit(user, 'rule.updated', r.id);
          emit(r.brand_id, { ruleId: r.id });
          host.json(res, 200, { rule: view(r, repo.lists(r.brand_id)) });
          return true;
        }
      }
      if ((m = /^\/api\/rules\/([A-Za-z0-9-]{1,64})\/(activate|pause|archive)$/.exec(path)) && method === 'POST') {
        const to = { activate: 'active', pause: 'paused', archive: 'archived' }[m[2]];
        const r = setStatus(user, m[1], (await host.body(req)) ?? {}, to);
        host.audit(user, 'rule.' + m[2], r.id);
        emit(r.brand_id, { ruleId: r.id });
        host.json(res, 200, { rule: view(r, repo.lists(r.brand_id)) });
        return true;
      }
      if ((m = /^\/api\/rules\/([A-Za-z0-9-]{1,64})\/runs$/.exec(path)) && method === 'GET') {
        const r = locate(user, m[1], 'inbox.view');
        const before = Number(url.searchParams.get('before')) || null;
        const runs = repo.runs(r.brand_id, r.id, { before, limit: 50 });
        host.json(res, 200, {
          runs: runs.map(x => ({
            id: x.id,
            revision: x.rule_revision,
            conversationId: x.conversation_id,
            outcome: x.outcome,
            voice: Boolean(x.voice),
            actions: x.actions.map(a => ({
              ...a,
              label: ACTIONS[a.type]?.label ?? a.type,
              why: REASONS[a.reason] ?? null,
            })),
            reason: x.reason,
            createdAt: x.created_at,
          })),
          nextBefore: runs.length === 50 ? runs.at(-1).created_at : null,
        });
        return true;
      }
      return false;
    }

    // Purga de la bitácora (conciliación, fila 48: ejecuciones de reglas, 90 días), por trozos.
    function purge() {
      repo.purge(now());
    }

    return { handle, purge, runner, repo };
  },
  timers: [{ name: 'purga', everyMs: 3_600_000, testEveryMs: 60_000, run: api => api.purge() }],
};
