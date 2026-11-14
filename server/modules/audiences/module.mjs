// Audiencias (docs/PLAN_AUDIENCIAS.md; conciliación técnica, filas 12, 14, 16 y 18): a quién se le envía una
// difusión. Una LISTA es un conjunto fijo de contactos (por ejemplo, los de una importación); un SEGMENTO es un filtro
// vivo con la gramática común de condiciones (server/lib/conditions.mjs). Una lista con `role: 'suppression'` es una
// lista de exclusión de la marca: sus miembros nunca reciben difusiones.
//
//   GET   /api/audiences?brand=&archived=1             marcas visibles, audiencias de la marca (con prediseñados) y topes
//   GET   /api/audiences/fields?brand=                 campos del constructor de condiciones (forma del kit)
//   POST  /api/audiences                               {brandId, kind, name, description?, role?, definition?,
//                                                       contactIds?, fromAudienceId?, clientRef} → 201 {audience}
//   GET   /api/audiences/:id                           {audience} (un segmento se vuelve a contar)
//   PATCH /api/audiences/:id                           {name?, description?, definition?, role?, expectedRevision}
//   POST  /api/audiences/:id/duplicate                 {name, clientRef} → 201 {audience}
//   POST  /api/audiences/:id/archive · /restore        {expectedRevision} → {audience}; 409 si una campaña activa la usa
//   POST  /api/audiences/:id/recount                   {} → {audience}
//   POST  /api/audiences/preview                       {brandId, definition | audienceId | spec, requireConsent?}
//                                                       → {total, eligible, excluded:[{reason,label,count}], sample, ms}
//   GET   /api/audiences/:id/members?status=&reason=&cursor=&limit=&requireConsent=
//   POST  /api/audiences/:id/members                   {add?:[ids], remove?:[ids], clientRef?} (≤500 por llamada)
//
// Permisos: ver = `campaigns.view` en la marca; crear y editar = `audiences.edit`. El teléfono de cada miembro pasa
// por host.access.phone. Privacidad: quien no tiene `contacts.phone` no filtra por el contenido del teléfono, del
// correo ni de un dato personal; si pudiera, el conteo le diría lo que se le oculta.
//
// Para otros módulos (host.module('audiences')):
//   addContacts(brandId, audienceId, contactIds, {source, sourceRef, actorId}) → {added, refused}   componible
//   memberSql(brandId, audienceId, {alias}) → {sql, args}       predicado «el contacto <alias> es miembro»
//   selectSql(brandId, spec) → {sql, args}                       SELECT de ids: incluidos menos excluidos
//   members(brandId, spec, {after, limit, status, requireConsent}) → {rows, next}   por id, estable, con motivo
//   summary(brandId, spec, {requireConsent}) → {total, eligible, excluded}
//   importList / resolveImportList                               la lista destino de una importación
import { randomUUID } from 'node:crypto';
import {
  compile,
  evaluate,
  LIMITS as CONDITION_LIMITS,
  normalize,
  normalizeText,
  validate,
} from '../../lib/conditions.mjs';
import { CHANNELS, KINDS, REASONS, ROLES, buildFields, createRepo } from './repo.mjs';

export const LIMITS = Object.freeze({
  lists: 200, // listas propias activas por marca
  segments: 50, // segmentos propios activos por marca
  members: 50_000, // miembros por lista (lo mismo que admite una importación)
  perCall: 500, // contactos por llamada al añadir o quitar
  previewPerMinute: 60,
  specEntries: 5,
});
const PAGE = 50;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 300;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const UUID = /^[0-9a-f-]{36}$/;
const ROUTE = /^\/api\/audiences\/([0-9a-f-]{36})(?:\/(members|archive|restore|recount|duplicate))?$/;
const STATUSES = new Set(['all', 'eligible', 'excluded']);
// Estados de campaña en los que su público no puede desaparecer.
const LIVE_CAMPAIGN = new Set(['scheduled', 'sending', 'paused', 'stopped']);

const all = rules => ({ version: 1, match: 'all', groups: [{ match: 'all', rules }] });

// Segmentos prediseñados (diseño §4.3): no se editan, sí se duplican; se crean en cada marca la primera vez que se
// listan sus audiencias. Sus datos salen del CRM, no de columnas importadas.
export const PRESETS = Object.freeze([
  {
    key: 'all_valid',
    name: 'Todos con teléfono válido',
    description: 'Tienen teléfono y no pidieron la baja.',
    definition: all([
      { field: 'has_phone', op: 'is', value: true },
      { field: 'consent', op: 'neq', value: 'opted_out' },
    ]),
  },
  {
    key: 'winback',
    name: 'Para recuperar',
    description: 'Su último mensaje fue hace entre 30 y 90 días.',
    definition: all([
      { field: 'last_inbound', op: 'in_last_days', value: 90 },
      { field: 'last_inbound', op: 'not_in_last_days', value: 30 },
    ]),
  },
  {
    key: 'at_risk',
    name: 'En riesgo',
    description: 'No escriben desde hace más de 90 días, o nunca escribieron.',
    definition: all([{ field: 'last_inbound', op: 'not_in_last_days', value: 90 }]),
  },
  {
    key: 'pending_payment',
    name: 'Con pago pendiente',
    description: 'Tienen un pedido pendiente o en revisión.',
    definition: all([{ field: 'pending_order', op: 'is', value: true }]),
  },
  {
    key: 'interested_open',
    name: 'Interesados sin inscribirse',
    description: 'Tienen un interés nuevo, interesado o en inscripción y todavía no son alumnos.',
    definition: all([
      { field: 'stage', op: 'any', value: ['nuevo', 'interesado', 'inscripcion'] },
      { field: 'enrolled', op: 'is', value: false },
    ]),
  },
  {
    key: 'students',
    name: 'Alumnos inscritos',
    description: 'Tienen una inscripción vigente.',
    definition: all([{ field: 'enrolled', op: 'is', value: true }]),
  },
]);

// Una condición pregunta por el contenido de un dato que sólo ve quien tiene `contacts.phone`: teléfono, correo o un
// dato personal. «Tiene» o «no tiene» no revela nada que no se vea.
const PRESENCE = new Set(['empty', 'not_empty']);
export function sensitiveRule(rule, personalKeys) {
  if (!rule || typeof rule !== 'object') return false;
  if (rule.field === 'phone') return true;
  if (rule.field === 'email') return !PRESENCE.has(rule.op);
  if (rule.field === 'attr')
    return (rule.key === 'correo' || rule.key === 'telefono' || personalKeys.has(rule.key)) && !PRESENCE.has(rule.op);
  return false;
}
const rulesOf = definition =>
  (Array.isArray(definition?.groups) ? definition.groups : []).flatMap(group =>
    Array.isArray(group?.rules) ? group.rules : [],
  );

// Cursor de la lista de miembros: la posición (clave del nombre e id) en base64url. No es secreto: sólo dice dónde
// seguir dentro de lo que la persona ya puede ver.
const encodeCursor = next => (next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null);
function decodeCursor(text, fail) {
  if (!text) return null;
  const bad = () =>
    fail(400, 'La página pedida ya no es válida. Vuelve a cargar la lista.', { code: 'invalid_cursor' });
  if (typeof text !== 'string' || text.length > 600 || !/^[A-Za-z0-9_-]+$/.test(text)) throw bad();
  let data;
  try {
    data = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof data?.n !== 'string' || data.n.length > 400 || typeof data.i !== 'string' || !ID.test(data.i)) throw bad();
  return { n: data.n, i: data.i };
}

export default {
  name: 'audiences',
  create(host) {
    const { db, access } = host;
    const repo = createRepo(db);
    const now = () => Date.now();
    const fail = (status, message, extra) => host.fail(status, message, extra);
    const attributes = () => {
      try {
        return host.module('attributes');
      } catch {
        return null;
      }
    };
    const emit = (brandId, data) => host.realtime?.emit?.('audiences.changed', { brandId, data });

    // Una fusión de contactos mueve sus membresías al que queda, sin repetir (conciliación técnica, fila 18).
    host.personData.register({
      name: 'audiences',
      tables: ['audience_members'],
      merge: (keepId, mergedId) => ({ audience_members: repo.moveContact(keepId, mergedId, now()) }),
    });

    // ---- campos y condiciones

    // Campos de una marca: los del contacto, los propios de audiencias y los datos de contacto (atributos).
    function fieldsFor(brandId) {
      const options = {
        tags: repo.tags(brandId).map(t => t.id),
        courses: repo.courses(brandId).map(c => c.id),
        lists: repo.lists(brandId).map(l => l.id),
      };
      const extra = attributes()?.conditionFields?.(brandId, { alias: 'c' }) ?? [];
      return buildFields(options, extra);
    }
    const personalKeys = brandId =>
      new Set((attributes()?.definitions?.(brandId, { archived: true }) ?? []).filter(d => d.personal).map(d => d.key));

    // Valida un árbol de filtros y lo deja en forma canónica (conciliación técnica, fila 12: una forma, un módulo).
    // Con `user`, comprueba también la privacidad: sin `contacts.phone` no se filtra por el contenido de lo oculto.
    function normalizeDefinition(brandId, definition, user = null) {
      const fields = fieldsFor(brandId);
      const problems = validate(definition, fields, { sql: true });
      if (problems.length)
        throw fail(400, problems[0], { code: 'invalid_conditions', field: 'definition', details: { problems } });
      if (user && !access.can(user, 'contacts.phone', brandId)) {
        const personal = personalKeys(brandId);
        if (rulesOf(definition).some(rule => sensitiveRule(rule, personal)))
          throw fail(
            403,
            'Filtrar por el contenido del teléfono, del correo o de un dato personal requiere poder ver los datos completos del contacto.',
            { code: 'permission_denied', field: 'definition', details: { permission: 'contacts.phone' } },
          );
      }
      return normalize(definition, fields);
    }
    // La condición compilada de un segmento. Uno guardado que ya no se entiende (un dato archivado, una lista de
    // otra marca) responde 409 con los problemas: no pasa por vacío ni por «todos».
    function compileDefinition(brandId, definition, at = now()) {
      try {
        return compile(definition, fieldsFor(brandId), { now: at });
      } catch (error) {
        if (error?.code === 'invalid_conditions')
          throw fail(409, `El segmento ya no se puede evaluar: ${error.message}`, {
            code: 'segment_invalid',
            details: { problems: error.problems ?? [] },
          });
        throw error;
      }
    }
    // En memoria, con el mismo registro de campos: lo usan las pruebas para comprobar que SQL y memoria coinciden.
    // El registro de un contacto tal como lo leen los campos (con sus datos de contacto en «attr»).
    function recordOf(brandId, contactId) {
      const record = repo.record(brandId, contactId);
      return record && { ...record, ...(attributes()?.record?.(brandId, contactId) ?? {}) };
    }
    function evaluateDefinition(brandId, definition, contactId, at = now()) {
      const record = recordOf(brandId, contactId);
      return record ? evaluate(definition, record, fieldsFor(brandId), at) : false;
    }

    // ---- selección

    const selectOf = (brandId, audience, at) =>
      audience.kind === 'list'
        ? repo.selectFor(brandId, audience)
        : repo.selectFor(brandId, audience, compileDefinition(brandId, JSON.parse(audience.definition), at));

    function audienceOf(brandId, id) {
      const audience = typeof id === 'string' && UUID.test(id) ? repo.get(brandId, id) : null;
      if (!audience) throw fail(404, 'Audiencia no disponible.', { code: 'not_found' });
      return audience;
    }

    // Lo que se pide: una audiencia guardada, un filtro en línea o una especificación de público
    //   {version: 2, include: [{audienceId} | {all: true} | {definition}], exclude: [{audienceId}]}  (diseño §4.4)
    // → {include, exclude} como SELECT de ids. `user` sólo se pasa cuando lo pide una persona (privacidad).
    function resolveSpec(brandId, spec, user = null, at = now()) {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec))
        throw fail(400, 'Indica la audiencia, el filtro o el público.', { code: 'invalid_input', field: 'spec' });
      const entry = (item, where) => {
        if (item?.all === true) return repo.selectAll(brandId);
        if (typeof item?.audienceId === 'string') return selectOf(brandId, audienceOf(brandId, item.audienceId), at);
        if (item?.definition !== undefined)
          return repo.selectDefinition(
            brandId,
            compile(normalizeDefinition(brandId, item.definition, user), fieldsFor(brandId), { now: at }),
          );
        throw fail(400, `${where}: usa {audienceId}, {all: true} o {definition}.`, {
          code: 'invalid_input',
          field: 'spec',
        });
      };
      if (spec.include === undefined) return { include: entry(spec, 'Público'), exclude: null };
      const list = (value, name) => {
        if (value === undefined) return [];
        if (!Array.isArray(value) || value.length > LIMITS.specEntries)
          throw fail(400, `«${name}» admite hasta ${LIMITS.specEntries} entradas.`, {
            code: 'invalid_input',
            field: name,
          });
        return value;
      };
      const include = list(spec.include, 'include');
      if (!include.length)
        throw fail(400, 'Elige al menos una audiencia.', { code: 'invalid_input', field: 'include' });
      const exclude = list(spec.exclude, 'exclude').map((item, i) => {
        if (typeof item?.audienceId !== 'string')
          throw fail(400, `Exclusión ${i + 1}: usa {audienceId}.`, { code: 'invalid_input', field: 'exclude' });
        return entry(item, `Exclusión ${i + 1}`);
      });
      return {
        include: repo.union(include.map((item, i) => entry(item, `Inclusión ${i + 1}`))),
        exclude: repo.union(exclude),
      };
    }

    // ---- vistas

    function shape(a, extra = {}) {
      return {
        id: a.id,
        brandId: a.brand_id,
        kind: a.kind,
        role: a.role,
        name: a.name,
        description: a.description,
        preset: a.preset,
        source: a.source,
        sourceRef: a.source_ref,
        memberCount: a.member_count,
        countedAt: a.counted_at,
        status: a.status,
        archived: a.archived_at !== null,
        revision: a.revision,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
        ...(a.kind === 'segment' ? { definition: JSON.parse(a.definition) } : {}),
        ...extra,
      };
    }
    const reasonList = excluded =>
      Object.keys(REASONS)
        .filter(reason => excluded[reason])
        .map(reason => ({ reason, label: REASONS[reason], count: excluded[reason] }));
    function presentMember(user, brandId, row) {
      return {
        contactId: row.id,
        name: row.name,
        phone: access.phone(user, row.phone, brandId) ?? '',
        consent: row.consent,
        reason: row.reason,
        reasonLabel: row.reason ? REASONS[row.reason] : null,
      };
    }

    // ---- escrituras (todas en una transacción síncrona, sin red)

    function cleanName(value, field = 'name') {
      const name = String(value ?? '')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim()
        .replace(/\s+/g, ' ');
      if (!name || name.length > MAX_NAME)
        throw fail(400, `El nombre lleva de 1 a ${MAX_NAME} caracteres.`, { code: 'invalid_input', field });
      return { name, nameKey: normalizeText(name) || name.toLowerCase() };
    }
    function cleanDescription(value) {
      const text = String(value ?? '').trim();
      if (text.length > MAX_DESCRIPTION)
        throw fail(400, `La descripción admite hasta ${MAX_DESCRIPTION} caracteres.`, {
          code: 'invalid_input',
          field: 'description',
        });
      return text;
    }
    function freeName(brandId, nameKey, exceptId) {
      if (repo.nameTaken(brandId, nameKey, exceptId))
        throw fail(409, 'Ya hay una audiencia con ese nombre en la marca.', { code: 'audience_exists', field: 'name' });
    }
    function room(brandId, kind) {
      const max = kind === 'list' ? LIMITS.lists : LIMITS.segments;
      if (repo.active(brandId, kind) >= max)
        throw fail(
          409,
          `La marca ya tiene ${max} ${kind === 'list' ? 'listas' : 'segmentos'} activos. Archiva alguno.`,
          {
            code: 'audience_limit',
          },
        );
    }
    const contactIdsOf = (value, field) => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !ID.test(id)))
        throw fail(400, 'Los contactos deben ser una lista de identificadores.', { code: 'invalid_input', field });
      if (value.length > LIMITS.perCall)
        throw fail(400, `Como mucho ${LIMITS.perCall} contactos por llamada.`, { code: 'too_many', field });
      return [...new Set(value)];
    };
    const clientRefOf = input =>
      typeof input?.clientRef === 'string' && input.clientRef.trim() ? input.clientRef.trim().slice(0, 100) : null;

    // Crea una lista o un segmento. Componible: sin transacción ni permisos (los pone quien llama).
    function insertAudience(brandId, input, { actorId = null, clientRef = null, at = now() } = {}) {
      const id = randomUUID();
      repo.insert(brandId, { ...input, id, clientRef, createdBy: actorId, at });
      return repo.get(brandId, id);
    }

    function create(user, input) {
      const brandId = typeof input.brandId === 'string' ? input.brandId : '';
      access.require(user, 'audiences.edit', brandId);
      const clientRef = clientRefOf(input);
      if (clientRef) {
        const previous = repo.byClientRef(brandId, clientRef);
        if (previous) return { audience: previous, repeated: true };
      }
      const kind = input.kind;
      if (!KINDS.includes(kind))
        throw fail(400, 'El tipo es «list» o «segment».', { code: 'invalid_input', field: 'kind' });
      const role = input.role ?? 'audience';
      if (!ROLES.includes(role))
        throw fail(400, 'El papel es «audience» o «suppression».', { code: 'invalid_input', field: 'role' });
      if (role === 'suppression' && kind !== 'list')
        throw fail(400, 'Una lista de exclusión es una lista, no un segmento.', {
          code: 'invalid_input',
          field: 'role',
        });
      const { name, nameKey } = cleanName(input.name);
      const description = cleanDescription(input.description);
      const at = now();
      let definition = {};
      let copy = null;
      let source = 'manual';
      let sourceRef = null;
      if (kind === 'segment')
        definition = normalizeDefinition(brandId, input.definition ?? { version: 1, match: 'all', groups: [] }, user);
      const contactIds = kind === 'list' ? contactIdsOf(input.contactIds, 'contactIds') : [];
      if (kind === 'list' && input.fromAudienceId !== undefined) {
        const from = audienceOf(brandId, input.fromAudienceId);
        copy = selectOf(brandId, from, at);
        source = from.kind === 'segment' ? 'segment' : 'list';
        sourceRef = from.id;
      }
      const audience = host.transaction(db, () => {
        if (clientRef) {
          const previous = repo.byClientRef(brandId, clientRef);
          if (previous) return previous;
        }
        room(brandId, kind);
        freeName(brandId, nameKey);
        const made = insertAudience(
          brandId,
          { kind, role, name, nameKey, description, definition, source, sourceRef, countedAt: at },
          { actorId: user.id, clientRef, at },
        );
        if (copy)
          repo.copyInto(brandId, made.id, copy, { source, sourceRef, actorId: user.id, at, room: LIMITS.members });
        if (contactIds.length)
          repo.addMembers(brandId, made.id, contactIds, { source: 'manual', actorId: user.id, at });
        if (kind === 'segment') repo.setCount(brandId, made.id, repo.count(brandId, selectOf(brandId, made, at)), at);
        return repo.get(brandId, made.id);
      });
      host.audit(user, 'audience.created', audience.id);
      emit(brandId, { id: audience.id, kind: 'audience' });
      return { audience, repeated: false };
    }

    function requireRevision(audience, input) {
      if (!Number.isInteger(input?.expectedRevision))
        throw fail(400, 'Falta la revisión que estás editando (expectedRevision).', {
          code: 'invalid_input',
          field: 'expectedRevision',
        });
      if (input.expectedRevision !== audience.revision)
        throw fail(409, 'Otra persona cambió esta audiencia. Vuelve a abrirla.', {
          code: 'stale_record',
          details: { revision: audience.revision },
        });
    }

    function update(user, audience, input) {
      const brandId = audience.brand_id;
      access.require(user, 'audiences.edit', brandId);
      if (audience.preset)
        throw fail(400, 'Un segmento prediseñado no se edita: duplícalo.', { code: 'preset_read_only' });
      if (audience.archived_at !== null)
        throw fail(409, 'Restaura la audiencia antes de editarla.', { code: 'audience_archived' });
      requireRevision(audience, input);
      const named =
        input.name === undefined ? { name: audience.name, nameKey: audience.name_key } : cleanName(input.name);
      const description = input.description === undefined ? audience.description : cleanDescription(input.description);
      let definition = JSON.parse(audience.definition);
      if (input.definition !== undefined) {
        if (audience.kind !== 'segment')
          throw fail(400, 'Una lista no tiene condiciones: añade o quita contactos.', {
            code: 'invalid_input',
            field: 'definition',
          });
        definition = normalizeDefinition(brandId, input.definition, user);
      }
      const role = input.role ?? audience.role;
      if (!ROLES.includes(role) || (role === 'suppression' && audience.kind !== 'list'))
        throw fail(400, 'Sólo una lista puede ser de exclusión.', { code: 'invalid_input', field: 'role' });
      if (role !== audience.role && audience.role === 'audience') blockIfLive(audience);
      const at = now();
      const saved = host.transaction(db, () => {
        freeName(brandId, named.nameKey, audience.id);
        if (!repo.update(brandId, audience.id, { ...named, description, definition, role }, input.expectedRevision, at))
          throw fail(409, 'Otra persona cambió esta audiencia. Vuelve a abrirla.', { code: 'stale_record' });
        const fresh = repo.get(brandId, audience.id);
        if (fresh.kind === 'segment')
          repo.setCount(brandId, fresh.id, repo.count(brandId, selectOf(brandId, fresh, at)), at);
        return repo.get(brandId, audience.id);
      });
      host.audit(user, 'audience.updated', audience.id);
      emit(brandId, { id: audience.id, kind: 'audience' });
      return saved;
    }

    // Una audiencia usada por una campaña programada o en curso no se archiva ni cambia de papel.
    function blockIfLive(audience) {
      const live = repo.campaignsUsing(audience.brand_id, audience.id).filter(c => LIVE_CAMPAIGN.has(c.status));
      if (live.length)
        throw fail(409, 'Una campaña programada o en curso usa esta audiencia.', {
          code: 'audience_in_use',
          details: { campaigns: live.map(c => ({ id: c.id, title: c.title })) },
        });
    }

    function setArchived(user, audience, input, archived) {
      const brandId = audience.brand_id;
      access.require(user, 'audiences.edit', brandId);
      if ((audience.archived_at !== null) === archived) return { audience, unchanged: true };
      requireRevision(audience, input);
      if (archived) blockIfLive(audience);
      const at = now();
      const saved = host.transaction(db, () => {
        if (!archived) {
          freeName(brandId, audience.name_key, audience.id);
          if (!audience.preset) room(brandId, audience.kind);
        }
        if (!repo.setArchived(brandId, audience.id, archived, input.expectedRevision, at))
          throw fail(409, 'Otra persona cambió esta audiencia. Vuelve a abrirla.', { code: 'stale_record' });
        return repo.get(brandId, audience.id);
      });
      host.audit(user, archived ? 'audience.archived' : 'audience.restored', audience.id);
      emit(brandId, { id: audience.id, kind: 'audience' });
      return { audience: saved, unchanged: false };
    }

    function duplicate(user, audience, input) {
      const brandId = audience.brand_id;
      if (audience.kind === 'segment')
        return create(user, {
          brandId,
          kind: 'segment',
          name: input.name,
          description: audience.description,
          definition: JSON.parse(audience.definition),
          clientRef: input.clientRef,
        });
      return create(user, {
        brandId,
        kind: 'list',
        role: audience.role,
        name: input.name,
        description: audience.description,
        fromAudienceId: audience.id,
        clientRef: input.clientRef,
      });
    }

    function recount(audience) {
      const at = now();
      host.transaction(db, () => {
        if (audience.kind === 'list') repo.recountList(audience.brand_id, audience.id, at);
        else
          repo.setCount(
            audience.brand_id,
            audience.id,
            repo.count(audience.brand_id, selectOf(audience.brand_id, audience, at)),
            at,
          );
      });
      return repo.get(audience.brand_id, audience.id);
    }

    // Prediseñados que falten en la marca. Idempotente; si alguien ya usa el nombre, se añade «(prediseñado)».
    function ensurePresets(brandId) {
      const missing = PRESETS.filter(p => !repo.byPreset(brandId, p.key));
      if (!missing.length) return;
      const at = now();
      host.transaction(db, () => {
        for (const preset of missing) {
          if (repo.byPreset(brandId, preset.key)) continue;
          let named = cleanName(preset.name);
          if (repo.nameTaken(brandId, named.nameKey)) named = cleanName(`${preset.name} (prediseñado)`);
          if (repo.nameTaken(brandId, named.nameKey)) continue;
          const definition = normalize(preset.definition, fieldsFor(brandId));
          const made = insertAudience(
            brandId,
            {
              kind: 'segment',
              role: 'audience',
              ...named,
              description: preset.description,
              definition,
              preset: preset.key,
              source: 'preset',
            },
            { at },
          );
          repo.setCount(brandId, made.id, repo.count(brandId, selectOf(brandId, made, at)), at);
        }
      });
    }

    // ---- miembros (componible)

    // Añade contactos de la marca a una lista. Sin transacción propia: el importador lo llama dentro de la de su
    // trozo. Idempotente: un contacto que ya está no se repite. Lo que pasa del tope de la lista se cuenta en `refused`.
    function addContacts(brandId, audienceId, contactIds, { source = 'api', sourceRef = null, actorId = null } = {}) {
      const audience = audienceOf(brandId, audienceId);
      if (audience.kind !== 'list') throw fail(400, 'Sólo se añaden contactos a una lista.', { code: 'invalid_input' });
      if (audience.archived_at !== null) throw fail(409, 'La lista está archivada.', { code: 'audience_archived' });
      const ids = [...new Set((contactIds ?? []).filter(id => typeof id === 'string' && ID.test(id)))];
      const space = Math.max(LIMITS.members - audience.member_count, 0);
      const added = repo.addMembers(brandId, audience.id, ids, { source, sourceRef, actorId, at: now(), room: space });
      const already = repo.memberInfo(audience.id, ids).length;
      return { added, refused: Math.max(ids.length - already, 0) };
    }

    function editMembers(user, audience, input) {
      const brandId = audience.brand_id;
      access.require(user, 'audiences.edit', brandId);
      if (audience.kind !== 'list')
        throw fail(400, 'Un segmento se cambia con sus condiciones.', { code: 'invalid_input' });
      if (audience.archived_at !== null) throw fail(409, 'La lista está archivada.', { code: 'audience_archived' });
      const add = contactIdsOf(input.add, 'add');
      const remove = contactIdsOf(input.remove, 'remove');
      if (add.length + audience.member_count > LIMITS.members && add.length)
        throw fail(409, `Una lista admite hasta ${LIMITS.members} contactos.`, { code: 'audience_full' });
      const at = now();
      const result = host.transaction(db, () => ({
        added: repo.addMembers(brandId, audience.id, add, { source: 'manual', actorId: user.id, at }),
        removed: repo.removeMembers(brandId, audience.id, remove, at),
      }));
      if (result.added || result.removed) {
        host.audit(user, 'audience.members', audience.id);
        emit(brandId, { id: audience.id, kind: 'members' });
      }
      return { audience: repo.get(brandId, audience.id), ...result };
    }

    // ---- importación (conciliación técnica, fila 14: un solo importador; la lista es un destino más)

    // Valida la lista destino al guardar el mapeo: {audienceId} (una lista activa de la marca) o {name} (una lista
    // nueva que se crea al importar). Devuelve la forma que se guarda en las opciones de la importación, o null.
    function importList(user, brandId, input) {
      if (input === undefined || input === null || input === '') return null;
      if (typeof input !== 'object' || Array.isArray(input))
        throw fail(400, 'La lista destino es {audienceId} o {name}.', { code: 'invalid_input', field: 'options.list' });
      if (!access.can(user, 'audiences.edit', brandId))
        throw fail(400, 'Tu acceso no incluye «audiences.edit»: no puedes añadir los contactos a una lista.', {
          code: 'permission_denied',
          field: 'options.list',
          details: { permission: 'audiences.edit' },
        });
      if (typeof input.audienceId === 'string' && input.audienceId) {
        const audience = audienceOf(brandId, input.audienceId);
        if (audience.kind !== 'list' || audience.archived_at !== null)
          throw fail(400, 'Elige una lista activa de la marca.', { code: 'invalid_input', field: 'options.list' });
        return { audienceId: audience.id, name: audience.name };
      }
      const { name, nameKey } = cleanName(input.name, 'options.list');
      freeName(brandId, nameKey);
      return { name };
    }
    // Al lanzar la importación (dentro de su transacción): la lista existente o la nueva. Idempotente por la
    // importación: lanzarla otra vez encuentra la misma lista.
    function resolveImportList(brandId, list, { importId, actorId = null }) {
      if (!list) return null;
      if (list.audienceId) {
        const audience = audienceOf(brandId, list.audienceId);
        if (audience.kind !== 'list' || audience.archived_at !== null)
          throw fail(409, 'La lista destino ya no está activa.', { code: 'audience_archived' });
        return audience.id;
      }
      const clientRef = `import:${importId}`;
      const previous = repo.byClientRef(brandId, clientRef);
      if (previous) return previous.id;
      room(brandId, 'list');
      const { name, nameKey } = cleanName(list.name, 'options.list');
      freeName(brandId, nameKey);
      return insertAudience(
        brandId,
        {
          kind: 'list',
          role: 'audience',
          name,
          nameKey,
          description: '',
          source: 'import',
          sourceRef: importId,
          countedAt: now(),
        },
        { actorId, clientRef },
      ).id;
    }

    // Listas activas a las que la persona puede importar (para el asistente de importación); null sin permiso.
    function importTargets(user, brandId) {
      if (!access.can(user, 'audiences.edit', brandId)) return null;
      return repo
        .lists(brandId)
        .filter(l => l.archived_at === null)
        .map(l => ({ id: l.id, name: l.name, role: l.role }));
    }
    function describe(brandId, audienceId) {
      const audience = repo.get(brandId, audienceId);
      return audience ? { audienceId: audience.id, name: audience.name, memberCount: audience.member_count } : null;
    }

    // ---- para el motor de difusiones

    function memberSql(brandId, audienceId, { alias = 'c' } = {}) {
      if (!/^[a-z_][a-z0-9_]{0,20}$/.test(alias)) throw new TypeError('memberSql: alias de tabla no válido.');
      const select = selectOf(brandId, audienceOf(brandId, audienceId), now());
      return { sql: `${alias}.id IN (${select.sql})`, args: select.args };
    }
    function selectSql(brandId, spec) {
      const { include, exclude } = resolveSpec(brandId, spec);
      if (!exclude) return include;
      return {
        sql: `SELECT id FROM (${include.sql}) WHERE id NOT IN (${exclude.sql})`,
        args: [...include.args, ...exclude.args],
      };
    }
    function members(brandId, spec, { after = null, limit = 500, status = 'eligible', requireConsent = true } = {}) {
      const { include, exclude } = resolveSpec(brandId, spec);
      const page = repo.page(brandId, include, {
        exclude,
        requireConsent,
        status,
        order: 'id',
        after: after ? { i: String(after) } : null,
        limit: Math.min(Math.max(Number(limit) || 1, 1), 5000),
      });
      return {
        rows: page.rows.map(r => ({
          contactId: r.id,
          name: r.name,
          phone: r.phone,
          phoneKey: r.phone_key,
          personaId: r.persona_id,
          consent: r.consent,
          reason: r.reason,
        })),
        next: page.next ? page.next.i : null,
      };
    }
    function summary(brandId, spec, { requireConsent = true } = {}) {
      const { include, exclude } = resolveSpec(brandId, spec);
      return repo.summary(brandId, include, { exclude, requireConsent });
    }
    // ¿El contacto está en una lista de exclusión de la marca?
    const suppressed = (brandId, contactId) => {
      const s = repo.selectSuppressed(brandId);
      return Boolean(db.prepare(`SELECT 1 FROM (${s.sql}) WHERE contact_id = ?`).get(...s.args, contactId));
    };

    // Las campañas de catálogo pueden tomar una audiencia como público (`segment.audienceId`) y restan siempre las
    // listas de exclusión. El servicio existe antes que los módulos: se le presta la audiencia al crearse éste.
    const campaignSource = {
      check(brandId, audienceId) {
        const audience = audienceOf(brandId, audienceId);
        if (audience.archived_at !== null || audience.role !== 'audience')
          throw fail(400, 'Elige una audiencia activa de la marca.', {
            code: 'invalid_input',
            field: 'segment.audienceId',
          });
        return audience.id;
      },
      memberSql,
      suppressed,
    };
    host.services?.campaigns?.useAudiences?.(campaignSource);

    // ---- rutas

    const brandsFor = user => access.brandIds(user, 'campaigns.view');
    function view(user, brandId) {
      access.require(user, 'campaigns.view', brandId);
    }

    async function handle(req, res, path, user, url) {
      const method = req.method;
      if (method === 'GET' && path === '/api/audiences') {
        const brands = brandsFor(user);
        if (!brands.length) access.require(user, 'campaigns.view');
        const brandId = url.searchParams.get('brand') || brands[0];
        view(user, brandId);
        ensurePresets(brandId);
        const archived = url.searchParams.get('archived') === '1';
        host.json(res, 200, {
          brands: brands.map(id => ({ id, name: repo.brandName(id), canEdit: access.can(user, 'audiences.edit', id) })),
          brandId,
          canEdit: access.can(user, 'audiences.edit', brandId),
          audiences: repo.list(brandId, { archived }).map(a => shape(a)),
          reasons: Object.entries(REASONS).map(([reason, label]) => ({ reason, label })),
          limits: { ...LIMITS, ...CONDITION_LIMITS_VIEW },
          active: { lists: repo.active(brandId, 'list'), segments: repo.active(brandId, 'segment') },
        });
        return true;
      }
      if (method === 'GET' && path === '/api/audiences/fields') {
        const brandId = url.searchParams.get('brand') ?? '';
        view(user, brandId);
        host.json(res, 200, { fields: builderFields(user, brandId) });
        return true;
      }
      if (method === 'POST' && path === '/api/audiences') {
        const input = await host.body(req);
        const { audience, repeated } = create(user, input ?? {});
        host.json(res, repeated ? 200 : 201, { audience: shape(audience) });
        return true;
      }
      if (method === 'POST' && path === '/api/audiences/preview') {
        const input = (await host.body(req)) ?? {};
        const brandId = typeof input.brandId === 'string' ? input.brandId : '';
        view(user, brandId);
        host.rate(`audiences.preview:${user.id}`, LIMITS.previewPerMinute);
        const started = performance.now();
        const spec =
          input.spec ??
          (input.audienceId !== undefined ? { audienceId: input.audienceId } : { definition: input.definition });
        const requireConsent = input.requireConsent !== false;
        const { include, exclude } = resolveSpec(brandId, spec, user);
        const totals = repo.summary(brandId, include, { exclude, requireConsent });
        const sample = status =>
          repo
            .page(brandId, include, { exclude, requireConsent, status, limit: 5 })
            .rows.map(row => presentMember(user, brandId, row));
        host.json(res, 200, {
          total: totals.total,
          eligible: totals.eligible,
          excluded: reasonList(totals.excluded),
          sample: { eligible: sample('eligible'), excluded: sample('excluded') },
          ms: Math.round(performance.now() - started),
        });
        return true;
      }
      const match = ROUTE.exec(path);
      if (!match) return false;
      const [, id, action] = match;
      const brandId = repo.brandOf(id);
      if (!brandId) throw fail(404, 'Audiencia no disponible.', { code: 'not_found' });
      view(user, brandId);
      const audience = audienceOf(brandId, id);
      if (!action && method === 'GET') {
        const fresh = audience.kind === 'segment' && audience.archived_at === null ? recount(audience) : audience;
        host.json(res, 200, { audience: shape(fresh, { canEdit: access.can(user, 'audiences.edit', brandId) }) });
        return true;
      }
      if (!action && method === 'PATCH') {
        const saved = update(user, audience, (await host.body(req)) ?? {});
        host.json(res, 200, { audience: shape(saved) });
        return true;
      }
      if (action === 'duplicate' && method === 'POST') {
        const { audience: made, repeated } = duplicate(user, audience, (await host.body(req)) ?? {});
        host.json(res, repeated ? 200 : 201, { audience: shape(made) });
        return true;
      }
      if ((action === 'archive' || action === 'restore') && method === 'POST') {
        const result = setArchived(user, audience, (await host.body(req)) ?? {}, action === 'archive');
        host.json(res, 200, { audience: shape(result.audience), unchanged: result.unchanged });
        return true;
      }
      if (action === 'recount' && method === 'POST') {
        host.json(res, 200, { audience: shape(recount(audience)) });
        return true;
      }
      if (action === 'members' && method === 'GET') {
        const status = url.searchParams.get('status') ?? 'all';
        if (!STATUSES.has(status))
          throw fail(400, 'status es all, eligible o excluded.', { code: 'invalid_input', field: 'status' });
        const reason = url.searchParams.get('reason') || null;
        if (reason && !Object.hasOwn(REASONS, reason))
          throw fail(400, 'Motivo de exclusión desconocido.', { code: 'invalid_input', field: 'reason' });
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || PAGE, 1), PAGE);
        const after = decodeCursor(url.searchParams.get('cursor'), fail);
        const requireConsent = url.searchParams.get('requireConsent') !== '0';
        const include = selectOf(brandId, audience, now());
        const page = repo.page(brandId, include, { requireConsent, status, reason, after, limit });
        const added =
          audience.kind === 'list'
            ? new Map(
                repo
                  .memberInfo(
                    audience.id,
                    page.rows.map(r => r.id),
                  )
                  .map(r => [r.contact_id, r]),
              )
            : new Map();
        host.json(res, 200, {
          members: page.rows.map(row => ({
            ...presentMember(user, brandId, row),
            ...(added.has(row.id) ? { addedAt: added.get(row.id).added_at, source: added.get(row.id).source } : {}),
          })),
          next: encodeCursor(page.next),
          ...(after ? {} : { summary: summaryView(repo.summary(brandId, include, { requireConsent })) }),
        });
        return true;
      }
      if (action === 'members' && method === 'POST') {
        const result = editMembers(user, audience, (await host.body(req)) ?? {});
        host.json(res, 200, { audience: shape(result.audience), added: result.added, removed: result.removed });
        return true;
      }
      return false;
    }
    const summaryView = totals => ({
      total: totals.total,
      eligible: totals.eligible,
      excluded: reasonList(totals.excluded),
    });

    // Campos para el constructor del kit (public/kit/components/conditions.js): nombre, clave, operadores con el tipo
    // de valor que piden y opciones con su rótulo. Quien no ve los datos completos no recibe los campos que no puede
    // usar (teléfono, contenido del correo, datos personales).
    function builderFields(user, brandId) {
      const full = access.can(user, 'contacts.phone', brandId);
      const days = [
        { op: 'in_last_days', label: 'en los últimos (días)', valueType: 'number' },
        { op: 'not_in_last_days', label: 'no en los últimos (días)', valueType: 'number' },
        { op: 'before', valueType: 'date' },
        { op: 'after', valueType: 'date' },
      ];
      const yes = [{ op: 'is', valueType: 'boolean' }];
      const options = (items, value, label) => items.map(item => ({ value: item[value], label: item[label] }));
      const tags = options(repo.tags(brandId), 'id', 'name');
      const courses = options(repo.courses(brandId), 'id', 'title');
      const lists = repo
        .lists(brandId)
        .filter(l => l.archived_at === null)
        .map(l => ({ value: l.id, label: l.name }));
      const fields = [
        { name: 'name', label: 'Nombre', ops: ['contains', 'not_contains', 'starts_with'] },
        { name: 'has_phone', label: 'Tiene teléfono', ops: yes },
        {
          name: 'email',
          label: 'Correo',
          ops: [
            ...(full ? ['contains'] : []),
            { op: 'not_empty', label: 'tiene correo', valueType: 'none' },
            { op: 'empty', label: 'no tiene correo', valueType: 'none' },
          ],
        },
        ...(full ? [{ name: 'phone', label: 'Teléfono (dígitos)', ops: ['starts_with', 'contains'] }] : []),
        {
          name: 'consent',
          label: 'Consentimiento',
          ops: ['eq', 'neq', 'in'],
          options: [
            { value: 'unknown', label: 'Sin respuesta' },
            { value: 'opted_in', label: 'Aceptó mensajes' },
            { value: 'opted_out', label: 'No quiere mensajes' },
          ],
        },
        ...(tags.length ? [{ name: 'tag', label: 'Etiqueta', ops: ['any', 'all', 'none'], options: tags }] : []),
        ...(lists.length ? [{ name: 'list', label: 'Está en la lista', ops: ['any', 'none'], options: lists }] : []),
        {
          name: 'stage',
          label: 'Etapa de un interés',
          ops: ['any', 'none'],
          options: [
            { value: 'nuevo', label: 'Nuevo' },
            { value: 'interesado', label: 'Interesado' },
            { value: 'inscripcion', label: 'Inscripción' },
            { value: 'ganada', label: 'Ganada' },
            { value: 'perdida', label: 'Perdida' },
          ],
        },
        ...(courses.length
          ? [{ name: 'course', label: 'Curso de un interés', ops: ['any', 'none'], options: courses }]
          : []),
        { name: 'active_interest', label: 'Interés abierto', ops: yes },
        { name: 'enrolled', label: 'Es alumno inscrito', ops: yes },
        ...(courses.length
          ? [{ name: 'enrolled_course', label: 'Inscrito en el curso', ops: ['any', 'none'], options: courses }]
          : []),
        { name: 'pending_order', label: 'Tiene un pago pendiente', ops: yes },
        {
          name: 'last_inbound',
          label: 'Último mensaje del contacto',
          ops: [...days, { op: 'empty', label: 'nunca escribió', valueType: 'none' }],
        },
        { name: 'channel', label: 'Escribió por', ops: ['any', 'none'], options: CHANNELS },
        { name: 'created', label: 'Fecha de alta', ops: days },
        { name: 'activity', label: 'Última actividad', ops: days },
        {
          name: 'source',
          label: 'Origen',
          ops: ['in', 'not_in'],
          options: [
            { value: 'manual', label: 'Alta manual' },
            { value: 'laboratorio', label: 'Laboratorio' },
            { value: 'whatsapp', label: 'WhatsApp' },
            { value: 'import', label: 'Importación' },
            { value: 'api', label: 'API' },
          ],
        },
      ];
      // Datos de contacto propios de la marca (los de sistema ya están arriba con su nombre).
      for (const d of attributes()?.definitions?.(brandId) ?? []) {
        if (d.personal && !full) continue;
        const base = { name: 'attr', key: d.key, label: `Dato: ${d.label}` };
        if (d.type === 'select')
          fields.push({
            ...base,
            ops: ['eq', 'neq', 'in', 'empty', 'not_empty'].map(op => opOf(op)),
            options: d.options,
          });
        else if (d.type === 'number')
          fields.push({
            ...base,
            ops: ['eq', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'].map(op => opOf(op, 'number')),
          });
        else if (d.type === 'date')
          fields.push({ ...base, ops: ['before', 'after', 'empty', 'not_empty'].map(op => opOf(op, 'date')) });
        else if (d.type === 'boolean') fields.push({ ...base, ops: [{ op: 'is', valueType: 'boolean' }] });
        else
          fields.push({ ...base, ops: ['eq', 'contains', 'not_contains', 'empty', 'not_empty'].map(op => opOf(op)) });
      }
      return fields;
    }
    const opOf = (op, valueType) =>
      op === 'empty'
        ? { op, label: 'está vacío', valueType: 'none' }
        : op === 'not_empty'
          ? { op, label: 'tiene valor', valueType: 'none' }
          : valueType
            ? { op, valueType }
            : op;

    return {
      handle,
      addContacts,
      memberSql,
      selectSql,
      members,
      summary,
      normalizeDefinition,
      evaluateDefinition,
      fieldsFor,
      recordOf,
      compileDefinition,
      importList,
      resolveImportList,
      importTargets,
      describe,
      ensurePresets,
      suppressed,
      reasons: REASONS,
    };
  },
};

const CONDITION_LIMITS_VIEW = Object.freeze({
  groups: CONDITION_LIMITS.maxGroups,
  rules: CONDITION_LIMITS.maxRules,
  values: CONDITION_LIMITS.maxValues,
});
