// Atributos de contacto (docs/PLAN_ATRIBUTOS_CONTACTO.md): campos propios de cada marca sobre sus contactos (ciudad,
// curso de interés, estado de seguimiento…), con su tipo, su validación y su historial.
//
// Rutas (todas con sesión, bajo /api/attributes):
//   GET   /api/attributes?brand=&archived=1        definiciones de las marcas que se pueden ver, de sistema y límites
//   GET   /api/attributes/:id                       una definición
//   POST  /api/attributes                           crear (administración; clientRef)
//   PATCH /api/attributes/:id                       editar (administración; expectedRevision). key y type no cambian
//   POST  /api/attributes/:id/archive | /restore    archivar o restaurar (expectedRevision); los valores se conservan
//   GET   /api/attributes/contacts/:id              valores, datos de sistema e historial de un contacto
//   PUT   /api/attributes/contacts/:id              {changes:[{key, value, expected?}], clientRef} → valores
//
// Para otros módulos (host.module('attributes')): set (componible), read, record y conditionFields (condiciones de
// server/lib/conditions.mjs en memoria y en SQL), variableCatalogue y variableValues ({{contacto.<clave>}} de
// server/lib/variables.mjs).
import { randomUUID } from 'node:crypto';
import { createCatalogue } from '../../lib/variables.mjs';
import { registerSqlFunctions } from '../../lib/conditions.mjs';
import { conditionSql, createRepo } from './repo.mjs';
import { KEY, LIMITS, SYSTEM, SYSTEM_KEYS, TYPES, canonical, display, normalizeOptions, typed } from './model.mjs';

const EVENT = 'contacto.atributo_cambiado';
const SOURCES = new Set(['staff', 'rule', 'flow', 'import', 'api', 'mcp', 'system']);
const PREFIX = '/api/attributes';

const boolOf = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const textOf = (value, max) =>
  typeof value === 'string'
    ? value
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, max + 1)
    : '';

export default {
  name: 'attributes',
  create(host) {
    const { db } = host;
    const repo = createRepo(db);
    const now = () => Date.now();
    const fail = (status, message, extra) => host.fail(status, message, extra);
    // Las condiciones de texto comparan sin mayúsculas ni acentos también en SQL (cond_norm).
    registerSqlFunctions(db);

    // Los valores, el historial y las respuestas guardadas cuelgan del contacto: una fusión los mueve al que queda.
    host.personData.register({
      name: 'attributes',
      tables: ['contact_attribute_values', 'contact_attribute_events', 'contact_attribute_requests'],
      merge: (keepId, mergedId, ctx) =>
        repo.merge(ctx?.keep?.brand_id ?? repo.brandOfContact(keepId), keepId, mergedId),
    });
    host.services.events.registerTypes({
      [EVENT]: {
        title: 'Dato de contacto cambiado',
        entity: 'contact',
        payload:
          'key, label, from, to, source, contactId, conversationId, depth (sin from ni to si el dato es personal)',
      },
    });
    host.services.integrations?.registerNeeds?.({ [EVENT]: 'contacts' });

    // ---- definiciones
    const parse = row =>
      row && {
        ...row,
        options: JSON.parse(row.options || '[]'),
        personal: Boolean(row.personal),
        searchable: Boolean(row.searchable),
        show_in_chat: Boolean(row.show_in_chat),
      };
    const definitions = (brandId, options) => repo.definitions(brandId, options).map(parse);
    const shape = (d, usage = {}) => ({
      id: d.id,
      brandId: d.brand_id,
      key: d.key,
      label: d.label,
      type: d.type,
      typeLabel: TYPES[d.type] ?? d.type,
      options: d.options,
      description: d.description,
      personal: d.personal,
      searchable: d.searchable,
      showInChat: d.show_in_chat,
      position: d.position,
      origin: d.origin,
      status: d.status,
      revision: d.revision,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
      usage: { contacts: usage[d.id] ?? 0 },
    });
    const systemList = () =>
      SYSTEM.map(({ key, label, type, scope, options }) => ({
        key,
        label,
        type,
        scope,
        ...(options ? { options } : {}),
        system: true,
        readOnly: true,
      }));

    function locateDefinition(user, id, permission) {
      const brandId = repo.brandOfDefinition(id);
      if (!brandId) throw fail(404, 'Dato de contacto no disponible.', { code: 'not_found' });
      host.access.require(user, permission, brandId);
      return parse(repo.definition(brandId, id));
    }

    function readDefinitionInput(input, current) {
      const label = input.label === undefined && current ? current.label : textOf(input.label, LIMITS.label);
      if (!label) throw fail(400, 'Escribe cómo se llama el dato.', { code: 'attribute_invalid', field: 'label' });
      if (label.length > LIMITS.label)
        throw fail(400, `El nombre admite hasta ${LIMITS.label} caracteres.`, {
          code: 'attribute_invalid',
          field: 'label',
        });
      const description =
        input.description === undefined && current
          ? current.description
          : textOf(input.description, LIMITS.description);
      if (description.length > LIMITS.description)
        throw fail(400, `La descripción admite hasta ${LIMITS.description} caracteres.`, {
          code: 'attribute_invalid',
          field: 'description',
        });
      const type = current ? current.type : input.type;
      let options = input.options === undefined && current ? current.options : normalizeOptions(input.options);
      if (type !== 'select') options = [];
      else if (!options.length)
        throw fail(400, 'Una lista necesita al menos una opción.', { code: 'attribute_invalid', field: 'options' });
      const personal = boolOf(input.personal, current ? current.personal : false);
      const position = input.position === undefined ? current?.position : input.position;
      if (position !== undefined && !(Number.isInteger(position) && position >= 0 && position <= 1000))
        throw fail(400, 'La posición es un número entero de 0 a 1000.', {
          code: 'attribute_invalid',
          field: 'position',
        });
      return {
        label,
        description,
        options,
        personal,
        // Un dato personal no entra en la búsqueda.
        searchable: personal ? false : boolOf(input.searchable, current ? current.searchable : false),
        showInChat: boolOf(input.showInChat, current ? current.show_in_chat : true),
        position,
      };
    }

    function define(user, input) {
      const brandId = typeof input.brandId === 'string' ? input.brandId : '';
      host.access.require(user, 'contacts.attributes.manage', brandId);
      const clientRef = typeof input.clientRef === 'string' && input.clientRef ? input.clientRef.slice(0, 100) : null;
      return host.transaction(db, () => {
        if (clientRef) {
          const previous = repo.definitionByClientRef(brandId, clientRef);
          if (previous) return { definition: shape(parse(previous)), replayed: true };
          if (repo.clientRefTaken(brandId, clientRef))
            throw fail(409, 'Esa referencia ya se usó en otra marca.', { code: 'client_ref_conflict' });
        }
        const key = typeof input.key === 'string' ? input.key.trim() : '';
        if (!KEY.test(key))
          throw fail(
            400,
            'La clave va en minúsculas, sin espacios ni acentos, de 2 a 40 caracteres (letras, números y guion bajo).',
            { code: 'attribute_invalid', field: 'key' },
          );
        if (SYSTEM_KEYS.has(key))
          throw fail(409, `«${key}» es un dato del sistema; elige otra clave.`, {
            code: 'attribute_reserved',
            field: 'key',
          });
        if (!Object.hasOwn(TYPES, input.type))
          throw fail(400, 'Elige el tipo: texto, número, fecha, lista o sí/no.', {
            code: 'attribute_invalid',
            field: 'type',
          });
        if (repo.definitionByKey(brandId, key))
          throw fail(409, `Ya hay un dato con la clave «${key}» en esta marca (puede estar archivado).`, {
            code: 'attribute_exists',
            field: 'key',
          });
        if (repo.countActive(brandId) >= LIMITS.definitions)
          throw fail(
            409,
            `Cada marca admite hasta ${LIMITS.definitions} datos activos. Archiva alguno para crear otro.`,
            {
              code: 'attribute_limit',
            },
          );
        const fields = readDefinitionInput({ ...input, type: input.type }, null);
        const id = randomUUID();
        repo.insertDefinition(brandId, {
          id,
          key,
          type: input.type,
          ...fields,
          options: input.type === 'select' ? fields.options : [],
          position: fields.position ?? repo.nextPosition(brandId),
          origin: 'custom',
          clientRef,
          createdBy: user.id,
          at: now(),
        });
        return { definition: shape(parse(repo.definition(brandId, id))) };
      });
    }

    function update(user, id, input, status) {
      const current = locateDefinition(user, id, 'contacts.attributes.manage');
      const brandId = current.brand_id;
      if (!Number.isInteger(input.expectedRevision))
        throw fail(400, 'Falta la revisión que se está editando (expectedRevision).', { code: 'attribute_invalid' });
      if (input.key !== undefined && input.key !== current.key)
        throw fail(400, 'La clave de un dato no cambia: crea otro si necesitas una clave distinta.', {
          code: 'attribute_invalid',
          field: 'key',
        });
      if (input.type !== undefined && input.type !== current.type)
        throw fail(400, 'El tipo de un dato no cambia: crea otro si necesitas un tipo distinto.', {
          code: 'attribute_invalid',
          field: 'type',
        });
      return host.transaction(db, () => {
        const fresh = parse(repo.definition(brandId, id));
        const target = status ?? fresh.status;
        if (status && fresh.status === status)
          return { definition: shape(fresh, repo.usage(brandId)), unchanged: true };
        if (fresh.revision !== input.expectedRevision)
          throw fail(409, 'Otra persona cambió este dato. Revisa la versión actual antes de guardar.', {
            code: 'stale_record',
            details: { revision: fresh.revision },
          });
        const fields = status ? readDefinitionInput({}, fresh) : readDefinitionInput(input, fresh);
        if (fresh.type === 'select') {
          const kept = new Set(fields.options.map(option => option.value));
          const inUse = repo.optionUsage(brandId, id);
          const lost = Object.keys(inUse).find(value => !kept.has(value));
          if (lost)
            throw fail(409, `La opción «${lost}» la tienen ${inUse[lost]} contacto(s); no se puede quitar.`, {
              code: 'attribute_option_in_use',
              field: 'options',
              details: { option: lost, contacts: inUse[lost] },
            });
        }
        if (status === 'active' && repo.countActive(brandId) >= LIMITS.definitions)
          throw fail(409, `Cada marca admite hasta ${LIMITS.definitions} datos activos. Archiva alguno primero.`, {
            code: 'attribute_limit',
          });
        const changed = repo.updateDefinition(brandId, id, input.expectedRevision, {
          ...fields,
          position: fields.position ?? fresh.position,
          status: target,
          at: now(),
        });
        if (!changed) throw fail(409, 'Otra persona cambió este dato. Vuelve a intentarlo.', { code: 'stale_record' });
        return { definition: shape(parse(repo.definition(brandId, id)), repo.usage(brandId)) };
      });
    }

    // ---- valores
    const byKey = brandId => new Map(definitions(brandId).map(d => [d.key, d]));

    // Escribe varios valores de un contacto. Componible: sin transacción propia ni red. Un valor vacío borra; un valor
    // que ya es el guardado no hace nada. Escribe valor, historial y evento de dominio por cada cambio.
    //   changes: [{key, value, expected?}]; meta: {source, sourceId, actorId, conversationId, depth}
    function set(brandId, contactId, changes, meta = {}) {
      const source = SOURCES.has(meta.source) ? meta.source : 'staff';
      if (!repo.contact(brandId, contactId)) throw fail(404, 'Contacto no disponible.', { code: 'not_found' });
      const defs = byKey(brandId);
      const current = new Map(repo.values(brandId, contactId).map(row => [row.attribute_id, row]));
      const at = now();
      const changed = [];
      for (const change of changes) {
        const key = typeof change?.key === 'string' ? change.key.trim() : '';
        if (SYSTEM_KEYS.has(key))
          throw fail(400, `«${key}» es un dato del sistema y no se escribe aquí.`, {
            code: 'attribute_read_only',
            field: key,
          });
        const definition = defs.get(key);
        if (!definition)
          throw fail(400, `No hay un dato activo con la clave «${key}» en esta marca.`, {
            code: 'attribute_unknown',
            field: key || undefined,
          });
        let next;
        try {
          next = canonical(definition, change.value);
        } catch (error) {
          throw fail(400, error.message, { code: 'attribute_invalid', field: key });
        }
        const before = current.get(definition.id) ?? null;
        const from = before?.value ?? null;
        if (Object.hasOwn(change, 'expected')) {
          let expected = null;
          try {
            expected = canonical(definition, change.expected)?.value ?? null;
          } catch {
            expected = String(change.expected);
          }
          if (expected !== from)
            throw fail(409, `«${definition.label}» cambió mientras lo editabas. Revisa el valor actual.`, {
              code: 'stale_record',
              field: key,
              details: { key, current: from },
            });
        }
        const to = next?.value ?? null;
        if (to === from) continue;
        if (next)
          repo.setValue(brandId, {
            contactId,
            attributeId: definition.id,
            value: next.value,
            valueNum: next.valueNum,
            source,
            sourceId: meta.sourceId ?? null,
            actorId: meta.actorId ?? null,
            at,
          });
        else repo.deleteValue(brandId, contactId, definition.id);
        const seq = repo.insertEvent(brandId, {
          contactId,
          attributeId: definition.id,
          key,
          from,
          to,
          source,
          sourceId: meta.sourceId ?? null,
          actorId: meta.actorId ?? null,
          conversationId: meta.conversationId ?? null,
          depth: Number.isInteger(meta.depth) ? meta.depth : 0,
          at,
        });
        const payload = {
          key,
          label: definition.label,
          source,
          sourceId: meta.sourceId ?? null,
          contactId,
          conversationId: meta.conversationId ?? null,
          depth: Number.isInteger(meta.depth) ? meta.depth : 0,
          ...(definition.personal ? { redacted: true } : { from, to }),
        };
        host.services.events.publish({
          type: EVENT,
          brandId,
          entityKind: 'contact',
          entityId: contactId,
          payload,
          actorId: meta.actorId ?? null,
          source: 'attributes',
          dedupeKey: `${EVENT}:${seq}`,
        });
        current.set(definition.id, next ? { value: next.value, value_num: next.valueNum } : null);
        changed.push({ key, from, to });
      }
      if (changed.length) repo.touchContact(brandId, contactId, at);
      return { changed };
    }

    // Datos de sistema de un contacto, leídos de su tabla dueña: {clave: {value, display}}.
    function systemValues(brandId, contactId, user) {
      const contact = repo.contact(brandId, contactId);
      if (!contact) return {};
      const opportunity = repo.latestOpportunity(brandId, contactId);
      const tags = repo.tags(brandId, contactId);
      const consent = repo.consent(brandId, contactId);
      const fullContact = user ? host.access.can(user, 'contacts.phone', brandId) : true;
      const day = new Date(contact.created_at).toISOString().slice(0, 10);
      const consentDef = SYSTEM.find(item => item.key === 'consentimiento');
      const stageDef = SYSTEM.find(item => item.key === 'etapa');
      const maskEmail = email => (fullContact || !email ? email : email.replace(/^(.).*(@.*)$/, '$1•••$2'));
      return {
        nombre: { value: contact.name, display: contact.name },
        telefono: {
          value: user ? host.access.phone(user, contact.phone, brandId) : contact.phone,
          display: user ? host.access.phone(user, contact.phone, brandId) : contact.phone,
        },
        correo: { value: maskEmail(contact.email), display: maskEmail(contact.email) },
        origen: { value: contact.source, display: contact.source },
        creado: { value: day, display: display({ type: 'date' }, day), at: contact.created_at },
        consentimiento: { value: consent, display: display(consentDef, consent) },
        etiquetas: { value: tags.map(tag => tag.id), display: tags.map(tag => tag.name).join(', ') },
        etapa: { value: opportunity?.stage ?? null, display: display(stageDef, opportunity?.stage ?? '') },
        curso_interes: {
          value: opportunity?.course_id ?? null,
          display: opportunity?.course_title ?? opportunity?.course_id ?? '',
        },
      };
    }

    // Valores, datos de sistema e historial de un contacto, como los ve `user` (un dato personal se oculta a quien no
    // puede ver teléfono y correo completos).
    function read(brandId, contactId, user = null) {
      const contact = repo.contact(brandId, contactId);
      if (!contact) throw fail(404, 'Contacto no disponible.', { code: 'not_found' });
      const fullContact = user ? host.access.can(user, 'contacts.phone', brandId) : true;
      const defs = new Map(definitions(brandId, { archived: true }).map(d => [d.id, d]));
      const values = {};
      for (const row of repo.values(brandId, contactId)) {
        const d = defs.get(row.attribute_id);
        if (!d) continue;
        const hidden = d.personal && !fullContact;
        values[d.key] = {
          value: hidden ? null : row.value,
          display: hidden ? '•••' : display(d, row.value),
          label: d.label,
          type: d.type,
          status: d.status,
          source: row.source,
          updatedAt: row.updated_at,
          ...(hidden ? { hidden: true } : {}),
        };
      }
      const personalKeys = new Set([...defs.values()].filter(d => d.personal).map(d => d.key));
      const history = repo.history(brandId, contactId, LIMITS.history).map(row => {
        const hidden = personalKeys.has(row.key) && !fullContact;
        return {
          seq: row.seq,
          key: row.key,
          from: hidden ? null : row.old_value,
          to: hidden ? null : row.new_value,
          source: row.source,
          actor: row.actor_name ?? null,
          at: row.created_at,
          ...(hidden ? { hidden: true } : {}),
        };
      });
      return { contactId, brandId, values, system: systemValues(brandId, contactId, user), history };
    }

    // ---- condiciones (server/lib/conditions.mjs)
    // Declaración de la familia `attr` para el ámbito contacto: un atributo es
    // {"field": "attr", "key": "ciudad", "op": "eq", "value": "Puebla"}. Se combina con los campos de quien llama:
    //   const fields = defineFields([...mios, ...attributes.conditionFields(brandId)]);
    // En memoria se evalúa sobre `record(brandId, contactId)`; en SQL, sobre la tabla `contacts` con el alias dado.
    function conditionFields(brandId, { alias = 'c' } = {}) {
      const sql = conditionSql(alias);
      const members = {};
      for (const d of definitions(brandId)) {
        const read = record => record?.attr?.[d.key] ?? null;
        if (d.type === 'select')
          members[d.key] = { type: 'choice', label: d.label, options: d.options, read, sql: sql.value(d.id, 'text') };
        else if (d.type === 'text')
          members[d.key] = { type: 'text', label: d.label, read, sql: sql.value(d.id, 'text') };
        else members[d.key] = { type: d.type, label: d.label, read, sql: sql.value(d.id, 'num') };
      }
      const read = key => record => record?.attr?.[key] ?? null;
      for (const [key, expression] of Object.entries(sql.system)) {
        const item = SYSTEM.find(entry => entry.key === key);
        const type = item.type === 'select' ? 'choice' : item.type;
        members[key] = {
          type,
          label: item.label,
          read: read(key),
          sql: expression,
          ...(item.options ? { options: item.options } : {}),
        };
      }
      return [{ key: 'attr', label: 'Datos del contacto', members }];
    }

    // El registro que evalúa `conditionFields` en memoria: {attr: {clave: valor con su tipo}}.
    function record(brandId, contactId) {
      const contact = repo.contact(brandId, contactId);
      if (!contact) return { attr: {} };
      const attr = {};
      const defs = new Map(definitions(brandId).map(d => [d.id, d]));
      for (const row of repo.values(brandId, contactId)) {
        const d = defs.get(row.attribute_id);
        if (d) attr[d.key] = typed(d, row);
      }
      attr.nombre = contact.name;
      attr.correo = contact.email;
      attr.origen = contact.source;
      attr.creado = contact.created_at;
      attr.consentimiento = repo.consent(brandId, contactId);
      attr.etiquetas = repo.tags(brandId, contactId).map(tag => tag.id);
      return { attr };
    }

    // ---- variables (server/lib/variables.mjs): {{contacto.<clave>}}
    function variableCatalogue(brandId) {
      return createCatalogue([
        ...definitions(brandId).map(d => ({
          key: `contacto.${d.key}`,
          label: d.label,
          group: 'Datos del contacto',
          source: 'attribute',
          sample: d.type === 'select' ? (d.options[0]?.label ?? '') : d.label,
        })),
        ...SYSTEM.map(item => ({
          key: `contacto.${item.key}`,
          label: item.label,
          group: 'Datos del contacto',
          source: 'system',
          sample: item.label,
        })),
      ]);
    }
    // Valores para resolver {{contacto.<clave>}}: {contacto: {clave: texto}}. Lo vacío no aparece.
    function variableValues(brandId, contactId) {
      const { values, system } = read(brandId, contactId, null);
      const out = {};
      for (const [key, item] of Object.entries(system)) if (item.display) out[key] = String(item.display);
      for (const [key, item] of Object.entries(values))
        if (item.status === 'active' && item.display) out[key] = item.display;
      return { contacto: out };
    }

    // ---- rutas
    const emit = (brandId, data) => host.realtime.emit('attributes.changed', { brandId, data });

    function list(user, url) {
      const brand = url.searchParams.get('brand');
      const archived = url.searchParams.get('archived') === '1';
      let brandIds;
      if (brand) {
        host.access.require(user, 'contacts.view', brand);
        brandIds = [brand];
      } else brandIds = host.access.brandIds(user, 'contacts.view');
      if (!brandIds.length) host.access.require(user, 'contacts.view');
      return {
        brands: brandIds.map(brandId => {
          const usage = repo.usage(brandId);
          return {
            brandId,
            brandName: repo.brandName(brandId),
            canManage: host.access.can(user, 'contacts.attributes.manage', brandId),
            active: repo.countActive(brandId),
            definitions: definitions(brandId, { archived }).map(d => shape(d, usage)),
          };
        }),
        system: systemList(),
        types: Object.entries(TYPES).map(([value, label]) => ({ value, label })),
        limits: LIMITS,
      };
    }

    async function writeValues(req, res, user, contactId) {
      const brandId = repo.brandOfContact(contactId);
      if (!brandId) throw fail(404, 'Contacto no disponible.', { code: 'not_found' });
      host.access.require(user, 'contacts.edit', brandId);
      const input = await host.body(req);
      const changes = Array.isArray(input?.changes) ? input.changes : null;
      if (!changes || !changes.length)
        throw fail(400, 'Indica qué datos cambian: changes: [{key, value}].', { code: 'attribute_invalid' });
      if (changes.length > LIMITS.changes)
        throw fail(400, `Se pueden cambiar hasta ${LIMITS.changes} datos a la vez.`, { code: 'attribute_invalid' });
      const keys = changes.map(change => change?.key);
      if (new Set(keys).size !== keys.length)
        throw fail(400, 'Un mismo dato aparece dos veces en los cambios.', { code: 'attribute_invalid' });
      const clientRef = typeof input.clientRef === 'string' && input.clientRef ? input.clientRef.slice(0, 100) : null;
      const result = host.transaction(db, () => {
        if (clientRef) {
          const previous = repo.request(brandId, clientRef);
          if (previous) {
            if (previous.brand_id !== brandId || previous.contact_id !== contactId || previous.actor_id !== user.id)
              throw fail(409, 'Esa referencia ya se usó para otro cambio.', { code: 'client_ref_conflict' });
            return { ...JSON.parse(previous.response), replayed: true };
          }
        }
        const { changed } = set(brandId, contactId, changes, { source: 'staff', actorId: user.id });
        const response = { changed: changed.map(change => change.key) };
        if (clientRef) repo.saveRequest(brandId, { clientRef, contactId, actorId: user.id, response, at: now() });
        return response;
      });
      if (!result.replayed && result.changed.length) {
        host.audit(user, 'contact.attributes', contactId);
        emit(brandId, { kind: 'values', contactId, keys: result.changed });
      }
      host.json(res, 200, { ...result, ...read(brandId, contactId, user) });
    }

    async function handle(req, res, path, user, url) {
      if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;
      const parts = path.slice(PREFIX.length).split('/').filter(Boolean);
      const method = req.method;
      if (!parts.length) {
        if (method === 'GET') {
          host.json(res, 200, list(user, url));
          return true;
        }
        if (method === 'POST') {
          const input = (await host.body(req)) ?? {};
          const result = define(user, input);
          if (!result.replayed) {
            host.audit(user, 'attribute.created', result.definition.id);
            emit(result.definition.brandId, { kind: 'definitions', id: result.definition.id });
          }
          host.json(res, result.replayed ? 200 : 201, result);
          return true;
        }
        return false;
      }
      if (parts[0] === 'contacts' && parts.length === 2) {
        const contactId = parts[1];
        if (method === 'GET') {
          const brandId = repo.brandOfContact(contactId);
          if (!brandId) throw fail(404, 'Contacto no disponible.', { code: 'not_found' });
          host.access.require(user, 'contacts.view', brandId);
          host.json(res, 200, read(brandId, contactId, user));
          return true;
        }
        if (method === 'PUT') {
          await writeValues(req, res, user, contactId);
          return true;
        }
        return false;
      }
      const id = parts[0];
      if (parts.length === 1 && method === 'GET') {
        const d = locateDefinition(user, id, 'contacts.view');
        host.json(res, 200, { definition: shape(d, repo.usage(d.brand_id)) });
        return true;
      }
      const action =
        parts.length === 1 && method === 'PATCH' ? 'edit' : parts.length === 2 && method === 'POST' ? parts[1] : null;
      if (!['edit', 'archive', 'restore'].includes(action)) return false;
      const input = (await host.body(req)) ?? {};
      const status = action === 'archive' ? 'archived' : action === 'restore' ? 'active' : undefined;
      const result = update(user, id, input, status);
      if (!result.unchanged) {
        host.audit(
          user,
          'attribute.' + (action === 'edit' ? 'updated' : action === 'archive' ? 'archived' : 'restored'),
          id,
        );
        emit(result.definition.brandId, { kind: 'definitions', id });
      }
      host.json(res, 200, result);
      return true;
    }

    return {
      handle,
      definitions: (brandId, options) => definitions(brandId, options).map(d => shape(d)),
      system: systemList,
      set,
      read,
      record,
      conditionFields,
      variableCatalogue,
      variableValues,
    };
  },
};
