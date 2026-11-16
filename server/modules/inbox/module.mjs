// Bandeja nueva, incremento 2 (docs/PLAN_BANDEJA_VISTAS.md; diseño de bandeja §3.2–3.4 y §3.15): vistas del sistema
// con contador, vistas guardadas (personales o compartidas con la marca), filtros con la gramática común y búsqueda.
// Sólo lectura de conversaciones: el hilo, el compositor y las acciones siguen en la vista «Conversaciones».
//
//   GET    /api/inbox/views?brand=all|<marca>            vistas del sistema, vistas guardadas visibles y campos de filtro
//   POST   /api/inbox/views                              crear una vista guardada {name, brandId?, base, filter, sort,
//                                                        visibility: me|all, clientRef}
//   PATCH  /api/inbox/views/:id                          cambiarla {expectedRevision, clientRef?, …}
//   DELETE /api/inbox/views/:id                          archivarla {expectedRevision}
//   GET    /api/inbox/conversations?brand=&view=&filter=&sort=&cursor=&limit=
//                                                        una página (40 por omisión, 100 como mucho)
//   GET    /api/inbox/counts?brand=&views=a,b,saved:<id>  contadores, exactos hasta 9,999
//   GET    /api/inbox/search?brand=&q=                   personas, cursos y mensajes
//   GET    /api/inbox/filters?brand=                     opciones del constructor de filtros
//
// Alcance: cada consulta va por las marcas en las que la persona tiene `inbox.view` (host.access); una marca ajena
// responde lo mismo que una que no existe (404). Visibilidad dentro de la marca: hoy todos ven todas las conversaciones
// de sus marcas (valor `all` del diseño §6.3); cuando lleguen `team` y `own`, el predicado se añade en `scopeParts`.
//
// En vivo: un reloj mira los números de orden de messages y operation_events y avisa `inbox.changed` con los ids de
// cada marca (sin datos de clientes). El aviso `inbox.upsert` del ciclo de vida también sirve a la pantalla.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  describeFields,
  LIMITS as CONDITION_LIMITS,
  normalize,
  normalizeText,
  validate,
} from '../../lib/conditions.mjs';
import { phoneKey } from '../../lib/identity-keys.mjs';
import {
  CONVERSATION_FIELDS,
  SORTS,
  SYSTEM_KEYS,
  SYSTEM_VIEWS,
  createRepo,
  nameWords,
  previewOf,
  systemView,
} from './repo.mjs';

export const PAGE_LIMIT = 40;
export const MAX_LIMIT = 100;
export const COUNT_CAP = 9_999;
export const VIEW_LIMITS = Object.freeze({ personal: 30, sharedPerBrand: 50 });
export const VISIBILITIES = Object.freeze(['me', 'all']);
const SEARCH = Object.freeze({ min: 2, max: 100, people: 20, courses: 10, messages: 200, results: 40, window: 50_000 });
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const REF = /^[A-Za-z0-9_.:-]{8,100}$/;
const EMPTY = Object.freeze({ version: 1, match: 'any', groups: [] });

export default {
  name: 'inbox',
  create(host) {
    const { db, access } = host;
    const repo = createRepo(db);
    const now = () => Date.now();
    const bad = (message, field, code = 'invalid_input') => host.fail(400, message, { code, field });
    const notFound = () => host.fail(404, 'Vista o conversación no disponible.', { code: 'not_found' });

    // ---- Cursor firmado y atado a la consulta que lo produjo (como en la lista de contactos): uno escrito a mano o
    // traído de otra vista se rechaza con 400. La llave vive lo que vive el proceso.
    const key = randomBytes(32);
    const sign = text => createHmac('sha256', key).update(text).digest('base64url').slice(0, 22);
    const fingerprint = identity => sign(JSON.stringify(identity)).slice(0, 12);
    const encodeCursor = (next, identity) => {
      const body = Buffer.from(JSON.stringify({ v: next.v, i: next.i, f: fingerprint(identity) })).toString(
        'base64url',
      );
      return body + '.' + sign(body);
    };
    function decodeCursor(text, identity) {
      const invalid = () =>
        bad('La página pedida ya no es válida. Vuelve a cargar la lista.', 'cursor', 'invalid_cursor');
      if (typeof text !== 'string' || text.length > 400 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(text))
        throw invalid();
      const [body, mac] = text.split('.');
      if (!timingSafeEqual(Buffer.from(mac), Buffer.from(sign(body)))) throw invalid();
      let data;
      try {
        data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        throw invalid();
      }
      if (!Number.isSafeInteger(data?.v) || typeof data.i !== 'string' || !ID.test(data.i)) throw invalid();
      if (data.f !== fingerprint(identity)) throw invalid();
      return { v: data.v, i: data.i };
    }

    // ---- Marcas: `brand` es obligatorio. «all» son todas las de la persona con `inbox.view`; un id, sólo ésa.
    function brandsFor(user, brand) {
      if (typeof brand !== 'string' || !brand) throw bad('Indica la marca (brand=all o su identificador).', 'brand');
      if (brand === 'all') {
        access.require(user, 'inbox.view'); // 403 si no tiene el permiso en ninguna marca
        return access.brandIds(user, 'inbox.view').filter(id => access.can(user, 'inbox.view', id));
      }
      access.require(user, 'inbox.view', brand); // 403 sin permiso; 404 si la marca no es suya
      return [brand];
    }
    const allBrands = user => access.brandIds(user, 'inbox.view').filter(id => access.can(user, 'inbox.view', id));

    // ---- Filtros: la gramática común, validada; un campo u operador desconocido es 400 (nunca se ignora).
    function checkFilter(definition, field = 'filter') {
      const problems = validate(definition, CONVERSATION_FIELDS, { sql: true });
      if (problems.length)
        throw host.fail(400, problems[0], { code: 'invalid_conditions', field, details: { problems } });
      return normalize(definition, CONVERSATION_FIELDS);
    }
    function readFilter(url) {
      const raw = url.searchParams.get('filter');
      if (!raw) return null;
      if (raw.length > CONDITION_LIMITS.maxBytes)
        throw bad('El filtro es demasiado grande.', 'filter', 'invalid_conditions');
      let definition;
      try {
        definition = JSON.parse(raw);
      } catch {
        throw bad('El filtro no se pudo leer.', 'filter', 'invalid_conditions');
      }
      return checkFilter(definition);
    }
    // «me» en el responsable es quien consulta: así una vista compartida «Mías con…» sirve a cada quien.
    const forUser = (definition, user) => ({
      ...definition,
      groups: definition.groups.map(group => ({
        ...group,
        rules: group.rules.map(rule =>
          rule.field !== 'assignee' || rule.value === undefined
            ? rule
            : {
                ...rule,
                value: Array.isArray(rule.value)
                  ? rule.value.map(v => (v === 'me' ? user.id : v))
                  : rule.value === 'me'
                    ? user.id
                    : rule.value,
              },
        ),
      })),
    });
    const compiled = (definition, user, at) =>
      definition && definition.groups.length ? [repo.compileFilter(forUser(definition, user), at)] : [];

    // ---- Vistas guardadas: quién ve, quién edita
    const parseFilter = text => {
      try {
        return JSON.parse(text);
      } catch {
        return EMPTY;
      }
    };
    const canShare = (user, brandId) => Boolean(brandId) && access.can(user, 'inbox.views.share', brandId);
    function visibleTo(user, view) {
      if (!view || view.archived_at) return false;
      if (view.owner_id === user.id) return true;
      return view.visibility !== 'me' && Boolean(view.brand_id);
    }
    function editable(user, view) {
      if (view.visibility === 'me') return view.owner_id === user.id;
      return canShare(user, view.brand_id);
    }
    function present(user, view) {
      return {
        id: view.id,
        name: view.name,
        brandId: view.brand_id,
        brandName: view.brand_name ?? null,
        base: view.base,
        filter: parseFilter(view.filter),
        sort: view.sort,
        visibility: view.visibility,
        ownerName: view.owner_name,
        mine: view.owner_id === user.id,
        editable: editable(user, view),
        revision: view.revision,
        createdAt: view.created_at,
        updatedAt: view.updated_at,
      };
    }
    // La vista guardada `id` tal como la puede usar esta persona, o 404.
    function savedFor(user, id) {
      if (!ID.test(id)) throw notFound();
      const view = repo.viewById(allBrands(user), id);
      if (!visibleTo(user, view)) throw notFound();
      return view;
    }

    // ---- Lo que identifica una lista: marcas, vista, filtros y orden.
    function readList(user, url) {
      const brand = url.searchParams.get('brand');
      let brandIds = brandsFor(user, brand);
      const viewKey = url.searchParams.get('view') ?? 'all';
      let base;
      let stored = null;
      let naturalSort = 'recent';
      if (viewKey.startsWith('saved:')) {
        const view = savedFor(user, viewKey.slice(6));
        base = systemView(view.base) ?? systemView('all');
        stored = parseFilter(view.filter);
        naturalSort = view.sort;
        if (view.brand_id) brandIds = brandIds.filter(id => id === view.brand_id);
      } else {
        base = systemView(viewKey);
        if (!base) throw bad(`Vista desconocida: ${viewKey.slice(0, 40)}.`, 'view', 'invalid_view');
        naturalSort = base.sort ?? 'recent';
      }
      const extra = readFilter(url);
      const sort = url.searchParams.get('sort') ?? naturalSort;
      if (!Object.hasOwn(SORTS, sort)) throw bad('Orden no válido: usa recent, oldest o waiting.', 'sort');
      if (sort === 'waiting' && base.key !== 'unreplied')
        throw bad('«Espera más larga» sólo se puede usar en la vista Sin respuesta.', 'sort');
      return { brand, brandIds, base, stored, extra, sort, identity: { brand, view: viewKey, filter: extra, sort } };
    }
    function partsOf(user, list, at) {
      const fixed = [list.base.sql(user.id), ...compiled(list.stored, user, at), ...compiled(list.extra, user, at)];
      return () => fixed;
    }

    // ---- Una fila de la lista (diseño §3.15, lo que hoy existe).
    function presentRow(user, row, at) {
      return {
        id: row.id,
        brandId: row.brand_id,
        brandName: row.brand_name,
        channel: row.channel,
        number: row.wa_number ? { id: row.wa_number, label: row.number_label || '' } : null,
        customer: {
          name: row.customer_name,
          contactId: row.contact_id ?? null,
          phone: row.contact_phone ? (access.phone(user, row.contact_phone, row.brand_id) ?? '') : '',
          labNumber: row.wa_number ? '' : '#' + row.test_number,
        },
        course: { id: row.course_id, title: row.course_title, pending: Boolean(row.course_pending) },
        edition: row.edition_id ? { id: row.edition_id, name: row.edition_name } : null,
        state: row.state,
        stateSince: row.state_since,
        handler: row.bot_enabled ? 'assistant' : row.assigned_to ? 'person' : 'queue',
        assignee: row.assigned_to ? { id: row.assigned_to, name: row.assignee_name } : null,
        activityAt: row.updated_at,
        createdAt: row.created_at,
        preview: previewOf(row.last),
        lastKind: row.last?.sender_kind ?? null,
        unread: row.unread,
        window: row.window_until ? { until: row.window_until, open: row.window_until > at } : null,
        service: {
          revision: row.service_revision ?? 1,
          waitingSince: row.waiting_since ?? null,
          dueAt: row.due_at ?? null,
          priority: row.priority,
        },
        stage: row.stage ?? null,
        opportunityId: row.opportunity_id ?? null,
        tags: row.tags,
        origin: row.origin,
        cycle: row.cycle_count,
      };
    }

    function listPage(user, url) {
      const list = readList(user, url);
      const limitText = url.searchParams.get('limit');
      const limit = limitText === null ? PAGE_LIMIT : Number(limitText);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
        throw bad(`«limit» va de 1 a ${MAX_LIMIT}.`, 'limit');
      const cursorText = url.searchParams.get('cursor');
      const after = cursorText ? decodeCursor(cursorText, list.identity) : null;
      const at = now();
      const page = repo.page(list.brandIds, { sort: list.sort, after, limit, partsFor: partsOf(user, list, at) });
      const rows = repo.rows(list.brandIds, page.ids);
      const result = {
        conversations: rows.map(row => presentRow(user, row, at)),
        nextCursor: page.next ? encodeCursor(page.next, list.identity) : null,
        view: list.identity.view,
        sort: list.sort,
      };
      if (!after) result.total = repo.count(list.brandIds, { partsFor: partsOf(user, list, at), cap: COUNT_CAP });
      return result;
    }

    // ---- Contadores: las vistas del sistema y las guardadas que se pidan (por omisión, todas las visibles).
    function counts(user, url) {
      const brand = url.searchParams.get('brand');
      const brandIds = brandsFor(user, brand);
      const raw = url.searchParams.get('views');
      let keys;
      if (raw === null || raw === '') {
        const saved = repo.viewsFor(allBrands(user), user.id).filter(view => visibleTo(user, view));
        keys = [...SYSTEM_KEYS, ...saved.map(view => 'saved:' + view.id)];
      } else {
        keys = [...new Set(raw.split(','))];
        if (keys.length > SYSTEM_KEYS.length + VIEW_LIMITS.personal + VIEW_LIMITS.sharedPerBrand)
          throw bad('Demasiadas vistas en una sola petición.', 'views');
      }
      const at = now();
      const result = {};
      for (const viewKey of keys) {
        let base;
        let stored = null;
        let ids = brandIds;
        if (viewKey.startsWith('saved:')) {
          const view = savedFor(user, viewKey.slice(6));
          base = systemView(view.base) ?? systemView('all');
          stored = parseFilter(view.filter);
          if (view.brand_id) ids = brandIds.filter(id => id === view.brand_id);
        } else {
          base = systemView(viewKey);
          if (!base) throw bad(`Vista desconocida: ${viewKey.slice(0, 40)}.`, 'views', 'invalid_view');
        }
        const fixed = [base.sql(user.id), ...compiled(stored, user, at)];
        result[viewKey] = repo.count(ids, { partsFor: () => fixed, cap: COUNT_CAP });
      }
      return { counts: result, at };
    }

    // ---- Búsqueda (§3.4): personas, cursos y mensajes, en ese orden, sin repetir conversación.
    function search(user, url) {
      const brandIds = brandsFor(user, url.searchParams.get('brand'));
      const q = (url.searchParams.get('q') ?? '').trim();
      if (q.length < SEARCH.min || q.length > SEARCH.max)
        throw bad(`La búsqueda lleva de ${SEARCH.min} a ${SEARCH.max} caracteres.`, 'q');
      host.rate('inbox-search:' + user.id, 60);
      const found = new Map();
      const add = (id, match) => {
        if (!found.has(id) && found.size < SEARCH.results) found.set(id, match);
      };
      const digits = q.replace(/\D/g, '');
      const isPhone = /^[\d\s+()./-]+$/.test(q) && digits.length >= 4;
      for (const brandId of brandIds) {
        let query;
        if (isPhone)
          // Quien no ve teléfonos completos en esta marca sólo busca por los cuatro últimos dígitos, los que ya ve.
          query = access.can(user, 'contacts.phone', brandId)
            ? { phone: { key: phoneKey(q) ?? '', digits } }
            : { phone: { last4: digits.slice(-4) } };
        else query = { words: nameWords(q).filter(word => word.length >= 2) };
        for (const hit of repo.searchPeople(brandId, query, SEARCH.people))
          add(hit.id, { kind: 'contact', text: hit.name });
      }
      const needle = normalizeText(q);
      let partial = false;
      if (needle.length >= SEARCH.min && !isPhone) {
        for (const brandId of brandIds)
          for (const hit of repo.searchCourses(brandId, needle, SEARCH.courses))
            add(hit.id, { kind: 'course', text: hit.title });
        const messages = repo.searchMessages(brandIds, needle, { window: SEARCH.window, limit: SEARCH.messages });
        partial = messages.partial;
        for (const hit of messages.hits) add(hit.id, { kind: 'message', text: previewOf(hit), seq: hit.seq });
      }
      const at = now();
      const rows = new Map(repo.rows(brandIds, [...found.keys()]).map(row => [row.id, row]));
      return {
        results: [...found]
          .filter(([id]) => rows.has(id))
          .map(([id, match]) => ({ conversation: presentRow(user, rows.get(id), at), match })),
        partial,
      };
    }

    function filterOptions(user, url) {
      const brandIds = brandsFor(user, url.searchParams.get('brand'));
      const options = repo.options(brandIds);
      return {
        brands: options.brands,
        courses: options.courses.map(course => ({ id: course.id, title: course.title, brandId: course.brand_id })),
        tags: options.tags.map(tag => ({ id: tag.id, name: tag.name, color: tag.color, brandId: tag.brand_id })),
        assignees: options.assignees,
        numbers: options.numbers.map(n => ({ id: n.id, label: n.label || n.id, brandId: n.brand_id })),
      };
    }

    // ---- Vistas guardadas: escribir
    function readView(input, current = null) {
      const pick = (name, fallback) => (Object.hasOwn(input, name) ? input[name] : fallback);
      const name = pick('name', current?.name);
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 60)
        throw bad('El nombre de la vista lleva de 1 a 60 caracteres.', 'name');
      const base = pick('base', current?.base ?? 'all');
      if (!SYSTEM_KEYS.includes(base)) throw bad('La vista de partida no existe.', 'base', 'invalid_view');
      const sort = pick('sort', current?.sort ?? systemView(base).sort ?? 'recent');
      if (!Object.hasOwn(SORTS, sort)) throw bad('Orden no válido: usa recent, oldest o waiting.', 'sort');
      if (sort === 'waiting' && base !== 'unreplied')
        throw bad('«Espera más larga» sólo se puede usar con la vista Sin respuesta.', 'sort');
      const visibility = pick('visibility', current?.visibility ?? 'me');
      if (!VISIBILITIES.includes(visibility))
        throw bad('«visibility» es me (sólo tú) o all (el equipo de la marca).', 'visibility');
      const brandId = pick('brandId', current?.brand_id ?? null);
      if (brandId !== null && (typeof brandId !== 'string' || !ID.test(brandId)))
        throw bad('Marca no válida.', 'brandId');
      if (visibility === 'all' && !brandId)
        throw bad('Para compartir una vista con el equipo, elige su marca.', 'brandId');
      const filter = checkFilter(pick('filter', current ? parseFilter(current.filter) : EMPTY) ?? EMPTY);
      return { name: name.trim(), base, sort, visibility, brandId, filter };
    }
    function authorizeView(user, view) {
      if (view.brandId) access.require(user, 'inbox.view', view.brandId);
      else access.require(user, 'inbox.view');
      if (view.visibility !== 'me' && !canShare(user, view.brandId))
        throw host.fail(403, 'Tu acceso no incluye «Compartir vistas guardadas».', {
          code: 'permission_denied',
          details: { permission: 'inbox.views.share' },
        });
    }
    function readRef(input, required) {
      const ref = input?.clientRef;
      if (ref === undefined || ref === null) {
        if (required) throw bad('Falta la referencia de la acción (clientRef).', 'clientRef');
        return null;
      }
      if (typeof ref !== 'string' || !REF.test(ref)) throw bad('La referencia de la acción no es válida.', 'clientRef');
      return ref;
    }
    function requireRevision(view, input) {
      if (!Number.isInteger(input?.expectedRevision))
        throw bad('Falta la revisión que estás editando (expectedRevision).', 'expectedRevision');
      if (input.expectedRevision !== view.revision)
        throw host.fail(409, 'Otra persona cambió esta vista. Vuelve a abrirla.', {
          code: 'stale_record',
          details: { revision: view.revision },
        });
    }
    const emitViews = brandId => {
      if (brandId) host.realtime.emit('inbox.views', { brandId, data: { brandId } });
    };

    function createView(user, input) {
      const clientRef = readRef(input, true);
      const previous = repo.viewByRef(user.id, clientRef);
      if (previous) return { status: 200, body: { view: present(user, previous), duplicate: true } };
      const view = readView(input);
      authorizeView(user, view);
      const id = host.transaction(db, () => {
        const again = repo.viewByRef(user.id, clientRef);
        if (again) return again.id;
        if (view.visibility === 'me' && repo.countOwn(user.id) >= VIEW_LIMITS.personal)
          throw host.fail(409, `Ya tienes ${VIEW_LIMITS.personal} vistas propias; borra alguna para crear otra.`, {
            code: 'limit_reached',
          });
        if (view.visibility !== 'me' && repo.countShared(view.brandId) >= VIEW_LIMITS.sharedPerBrand)
          throw host.fail(409, `La marca ya tiene ${VIEW_LIMITS.sharedPerBrand} vistas compartidas.`, {
            code: 'limit_reached',
          });
        return repo.createView(view.brandId, user.id, { ...view, clientRef }, now());
      });
      host.audit(user, 'inbox.view.created', id);
      if (view.visibility !== 'me') emitViews(view.brandId);
      return { status: 201, body: { view: present(user, repo.viewById(allBrands(user), id)) } };
    }

    function updateView(user, id, input) {
      const current = savedFor(user, id);
      const ref = readRef(input, false);
      // Un reintento del mismo cambio ya aplicado devuelve la vista como quedó, sin conflicto.
      if (ref && current.last_ref === ref && current.revision === input?.expectedRevision + 1)
        return { view: present(user, current), duplicate: true };
      if (!editable(user, current))
        throw host.fail(403, 'Sólo quien la creó (o quien puede compartir vistas en su marca) puede cambiarla.', {
          code: 'permission_denied',
          details: { permission: 'inbox.views.share' },
        });
      requireRevision(current, input);
      const view = readView(input, current);
      authorizeView(user, view);
      // Una vista personal de otra persona nunca se vuelve compartida por un tercero: sólo su dueño decide.
      if (current.owner_id !== user.id && view.visibility === 'me')
        throw host.fail(403, 'Sólo quien creó la vista puede hacerla personal.', { code: 'permission_denied' });
      const ok = host.transaction(db, () => {
        if (
          current.visibility === 'me' &&
          view.visibility !== 'me' &&
          repo.countShared(view.brandId) >= VIEW_LIMITS.sharedPerBrand
        )
          throw host.fail(409, `La marca ya tiene ${VIEW_LIMITS.sharedPerBrand} vistas compartidas.`, {
            code: 'limit_reached',
          });
        return repo.updateView(view.brandId, current.id, input.expectedRevision, view, user.id, ref, now());
      });
      if (!ok) throw host.fail(409, 'Otra persona cambió esta vista. Vuelve a abrirla.', { code: 'stale_record' });
      host.audit(user, 'inbox.view.updated', current.id);
      emitViews(current.brand_id);
      if (view.brandId !== current.brand_id) emitViews(view.brandId);
      return { view: present(user, repo.viewById(allBrands(user), current.id)) };
    }

    function archiveView(user, id, input) {
      if (!ID.test(id)) throw notFound();
      const current = repo.viewById(allBrands(user), id);
      if (!current || !(current.owner_id === user.id || (current.visibility !== 'me' && current.brand_id)))
        throw notFound();
      if (current.archived_at) return { archived: true, duplicate: true }; // reintento de un borrado ya hecho
      if (!editable(user, current))
        throw host.fail(403, 'Sólo quien la creó (o quien puede compartir vistas en su marca) puede borrarla.', {
          code: 'permission_denied',
          details: { permission: 'inbox.views.share' },
        });
      requireRevision(current, input);
      if (!repo.archiveView(current.brand_id, current.id, input.expectedRevision, user.id, now()))
        throw host.fail(409, 'Otra persona cambió esta vista. Vuelve a abrirla.', { code: 'stale_record' });
      host.audit(user, 'inbox.view.archived', current.id);
      emitViews(current.brand_id);
      return { archived: true };
    }

    function listViews(user, url) {
      const brandIds = brandsFor(user, url.searchParams.get('brand') ?? 'all');
      const saved = repo
        .viewsFor(allBrands(user), user.id)
        .filter(view => visibleTo(user, view))
        .filter(view => !view.brand_id || brandIds.includes(view.brand_id));
      return {
        system: SYSTEM_VIEWS.map(view => ({
          key: view.key,
          name: view.name,
          description: view.description,
          sort: view.sort ?? 'recent',
        })),
        saved: saved.map(view => present(user, view)),
        shareBrands: brandIds.filter(id => canShare(user, id)),
        limits: VIEW_LIMITS,
        fields: describeFields(CONVERSATION_FIELDS),
      };
    }

    // ---- Avisos en vivo
    let seen = repo.cursors();
    function tick() {
      const { changes, seen: next } = repo.changesSince(seen);
      seen = next;
      if (!changes.length) return 0;
      const byBrand = new Map();
      for (const change of changes) {
        if (!byBrand.has(change.brand_id)) byBrand.set(change.brand_id, new Set());
        byBrand.get(change.brand_id).add(change.conversation_id);
      }
      for (const [brandId, ids] of byBrand) {
        const list = [...ids];
        for (let at = 0; at < list.length; at += 50)
          host.realtime.emit('inbox.changed', { brandId, data: { ids: list.slice(at, at + 50) } });
      }
      return changes.length;
    }

    const READS = {
      '/api/inbox/conversations': listPage,
      '/api/inbox/counts': counts,
      '/api/inbox/search': search,
      '/api/inbox/filters': filterOptions,
      '/api/inbox/views': listViews,
    };

    return {
      tick,
      async handle(req, res, path, user, url) {
        if (req.method === 'GET') {
          const read = Object.hasOwn(READS, path) ? READS[path] : null;
          if (!read) return false;
          host.json(res, 200, read(user, url));
          return true;
        }
        if (req.method === 'POST' && path === '/api/inbox/views') {
          const result = createView(user, (await host.body(req)) ?? {});
          host.json(res, result.status, result.body);
          return true;
        }
        const match = path.match(/^\/api\/inbox\/views\/([^/]+)$/);
        if (match && req.method === 'PATCH') {
          host.json(res, 200, updateView(user, match[1], (await host.body(req)) ?? {}));
          return true;
        }
        if (match && req.method === 'DELETE') {
          host.json(res, 200, archiveView(user, match[1], (await host.body(req)) ?? {}));
          return true;
        }
        return false;
      },
    };
  },
  // Avisos en vivo cada 2 s (200 ms en pruebas): dos lecturas por clave primaria, sin datos de clientes.
  timers: [{ name: 'avisos', everyMs: 2000, testEveryMs: 200, run: api => api.tick() }],
};
