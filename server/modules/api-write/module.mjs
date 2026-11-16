// API v1 de escritura: contactos (docs/PLAN_API_ESCRITURA.md; diseño de identidad y API §4.1–§4.7; conciliación
// técnica, filas 14, 15, 17 y 47; incrementos I-6 e I-7a).
//
// Este módulo no tiene rutas con sesión: presta sus rutas a la API v1 de server/integrations.mjs (useWriter), que
// autentica la llave, aplica los límites y responde los errores con el formato único. Aquí viven:
//   · la idempotencia (cabecera Idempotency-Key, 7 días): la operación y su registro en api_requests se escriben en
//     UNA transacción síncrona, así que dos peticiones con la misma clave nunca hacen el efecto dos veces;
//   · las rutas de contactos, que escriben SIEMPRE con la tubería única de la importación (`applyRow`, conciliación
//     fila 14) y con las funciones componibles de etiquetas, datos propios y listas (fila 17); ningún SQL propio
//     escribe contactos;
//   · las reglas de consentimiento (fila 15 y §4.7): la aceptación pide el permiso consent_write y el origen
//     declarado; una baja se registra siempre y la API nunca la levanta.
//
// La marca es SIEMPRE la de la llave: un contacto o una lista de otra marca responde 404, igual que uno inexistente.
// Las respuestas de escritura son mínimas (ids y estados): es lo que se guarda para repetirlas.
import { canonicalPhone } from '../../lib/identity-keys.mjs';
import { countryOptions } from '../contact-import/mapping.mjs';
import { definitionOf, varsOf } from '../wa-templates/definition.mjs';
import { createRepo, IDEM_TTL_MS } from './repo.mjs';

export const LIMITS = Object.freeze({ batch: 100, listAdd: 100, tagsPerCall: 12, attributesPerCall: 50 });

const UUID = /^[a-f0-9-]{36}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UPSERT_FIELDS = ['phone', 'countryCode', 'name', 'email', 'attributes', 'tags', 'consent', 'overwriteName'];
const PATCH_FIELDS = ['phone', 'countryCode', 'name', 'email', 'attributes', 'expectedUpdatedAt'];
// La misma normalización de nombres de etiqueta que server/contacts.mjs.
const norm = v =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');

const ROUTES = [
  { name: 'templates', method: 'GET', pattern: '/api/v1/templates', scope: 'templates', kind: 'read' },
  { name: 'lists', method: 'GET', pattern: '/api/v1/lists', scope: 'contacts', kind: 'read' },
  { name: 'contact', method: 'GET', pattern: '/api/v1/contacts/{id}', scope: 'contacts', kind: 'read' },
  // POST para que el teléfono o el correo no viajen en la dirección (los registros del proxy guardan direcciones).
  { name: 'lookup', method: 'POST', pattern: '/api/v1/contacts/lookup', scope: 'contacts', kind: 'read' },
  {
    name: 'upsert',
    method: 'POST',
    pattern: '/api/v1/contacts',
    scope: 'contacts_write',
    kind: 'write',
    idem: 'optional',
    action: 'api.contact.upsert',
  },
  {
    name: 'batch',
    method: 'POST',
    pattern: '/api/v1/contacts/batch',
    scope: 'contacts_write',
    kind: 'write',
    idem: 'required',
    action: 'api.contact.batch',
  },
  {
    name: 'patch',
    method: 'PATCH',
    pattern: '/api/v1/contacts/{id}',
    scope: 'contacts_write',
    kind: 'write',
    idem: 'optional',
    action: 'api.contact.update',
  },
  {
    name: 'tags',
    method: 'POST',
    pattern: '/api/v1/contacts/{id}/tags',
    scope: 'contacts_write',
    kind: 'write',
    idem: 'optional',
    action: 'api.contact.tags',
  },
  {
    name: 'consent',
    method: 'PUT',
    pattern: '/api/v1/contacts/{id}/consent',
    scope: 'contacts_write',
    kind: 'write',
    idem: 'optional',
    action: 'api.consent',
  },
  {
    name: 'listAdd',
    method: 'POST',
    pattern: '/api/v1/lists/{id}/contacts',
    scope: 'contacts_write',
    kind: 'write',
    idem: 'optional',
    action: 'api.list.add',
  },
];

export default {
  name: 'api-write',
  create(host) {
    const { db } = host;
    const repo = createRepo(db);
    const now = () => Date.now();
    const fail = (status, message, extra) => host.fail(status, message, extra);
    const bad = (message, field) => fail(400, message, { code: 'invalid_request', ...(field ? { field } : {}) });
    const importer = () => host.module('contact-import');
    const attributes = () => host.module('attributes');
    const audiences = () => host.module('audiences');
    const contacts = host.services.contacts;
    const integrations = host.services.integrations;
    const scopesOf = key => integrations.scopesOf(key);

    // ---- entrada

    function contactData(input, fields) {
      const extra = Object.keys(input).find(k => !fields.includes(k));
      if (extra) throw bad(`El campo «${extra}» no se reconoce en esta ruta.`, extra);
      const str = (name, max) => {
        const v = input[name];
        if (v === undefined || v === null) return undefined;
        if (typeof v !== 'string' || v.length > max)
          throw bad(`«${name}» debe ser texto de hasta ${max} caracteres.`, name);
        return v;
      };
      if (input.overwriteName !== undefined && typeof input.overwriteName !== 'boolean')
        throw bad('«overwriteName» es true o false.', 'overwriteName');
      const data = {
        phone: str('phone', 60),
        countryCode: str('countryCode', 8),
        name: str('name', 100),
        email: str('email', 150),
        attrs: attributesOf(input.attributes),
        tags: tagsOf(input.tags),
        consent: consentOf(input.consent),
        overwriteName: input.overwriteName === true,
      };
      if (fields === UPSERT_FIELDS && !data.phone?.trim())
        throw bad('Falta el teléfono (phone): con él se reconoce al contacto.', 'phone');
      return data;
    }
    function attributesOf(v) {
      const out = { set: {}, clear: [] };
      if (v === undefined || v === null) return out;
      if (typeof v !== 'object' || Array.isArray(v))
        throw bad('«attributes» es un objeto { clave: valor }.', 'attributes');
      const entries = Object.entries(v);
      if (entries.length > LIMITS.attributesPerCall)
        throw bad(`Hasta ${LIMITS.attributesPerCall} datos por petición.`, 'attributes');
      for (const [key, value] of entries) {
        if (key.length > 60) throw bad('Clave de dato demasiado larga.', 'attributes');
        if (value !== null && !['string', 'number', 'boolean'].includes(typeof value))
          throw bad(`El valor de «${key}» debe ser texto, número, sí/no o null.`, 'attributes.' + key);
        if (value === null || (typeof value === 'string' && !value.trim())) out.clear.push(key);
        else out.set[key] = String(value);
      }
      return out;
    }
    function tagsOf(v) {
      if (v === undefined || v === null) return { add: [], remove: [] };
      const raw = Array.isArray(v) ? { add: v } : v;
      if (typeof raw !== 'object') throw bad('«tags» es una lista de nombres o { add, remove }.', 'tags');
      const extra = Object.keys(raw).find(k => !['add', 'remove'].includes(k));
      if (extra) throw bad('«tags» admite sólo add y remove.', 'tags.' + extra);
      const list = name => {
        const items = raw[name] ?? [];
        if (!Array.isArray(items) || items.length > LIMITS.tagsPerCall || items.some(t => typeof t !== 'string'))
          throw bad(`«tags.${name}» es una lista de hasta ${LIMITS.tagsPerCall} nombres.`, 'tags.' + name);
        return items;
      };
      return { add: list('add'), remove: list('remove') };
    }
    function consentOf(v) {
      if (v === undefined || v === null) return null;
      if (typeof v !== 'object' || Array.isArray(v)) throw bad('«consent» es { status, source, evidence }.', 'consent');
      const extra = Object.keys(v).find(k => !['status', 'source', 'evidence'].includes(k));
      if (extra) throw bad('«consent» admite sólo status, source y evidence.', 'consent.' + extra);
      if (!['opted_in', 'opted_out'].includes(v.status))
        throw bad('«consent.status» es opted_in u opted_out.', 'consent.status');
      const source = typeof v.source === 'string' ? v.source.trim() : '';
      const evidence = typeof v.evidence === 'string' ? v.evidence.trim() : '';
      if (v.evidence !== undefined && (typeof v.evidence !== 'string' || evidence.length > 200))
        throw bad('«consent.evidence» es texto de hasta 200 caracteres.', 'consent.evidence');
      if (v.status === 'opted_in' && (source.length < 10 || source.length > 200))
        throw bad(
          'Para registrar que la persona aceptó, di de dónde viene el permiso (consent.source, de 10 a 200 caracteres).',
          'consent.source',
        );
      return { status: v.status, source, evidence };
    }

    // ---- la escritura de un contacto, siempre por la tubería única

    // Error de una fila de applyRow → error de la API, sin el valor que lo causó (puede ser un dato personal).
    function rowError(result) {
      const status = result.reason === 'not_found' ? 404 : result.reason === 'permission_denied' ? 403 : 422;
      const field = result.field ? String(result.field).replace(/^attr:/, 'attributes.') : undefined;
      const code = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(result.reason ?? '') ? result.reason : 'invalid_request';
      return fail(status, result.message, { code, ...(field ? { field } : {}) });
    }

    function writeContact(ctx, data, contactId = null) {
      const { key, actor } = ctx;
      const brandId = key.brand_id;
      const scopes = scopesOf(key);
      // Quien no ve teléfonos ni datos personales (permiso «contacts») tampoco escribe datos personales.
      const reveal = scopes.includes('contacts');
      const warnings = [];
      let consent = null;
      let consentMode = { mode: 'none' };
      if (data.consent?.status === 'opted_out') consent = false;
      if (data.consent?.status === 'opted_in') {
        if (!scopes.includes('consent_write'))
          throw fail(403, 'Registrar que una persona aceptó mensajes pide el permiso «consent_write».', {
            code: 'scope_missing',
            field: 'consent',
            details: { scope: 'consent_write' },
          });
        consent = true;
        consentMode = {
          mode: 'declared',
          origin: data.consent.source + (data.consent.evidence ? ` (evidencia: ${data.consent.evidence})` : ''),
        };
      }
      const result = importer().applyRow(
        brandId,
        {
          phone: data.phone,
          countryCode: data.countryCode,
          name: data.name,
          email: data.email,
          tags: data.tags.add,
          attrs: data.attrs.set,
          consent,
        },
        {
          onExisting: 'update',
          nameFallback: 'phone',
          actorId: actor.id,
          importId: key.id,
          label: key.name,
          consent: consentMode,
          source: 'api',
          contactId,
          keepName: !contactId && !data.overwriteName,
          attributeEvents: true,
          allow: { edit: true, tags: true, consent: true, phone: reveal },
        },
      );
      if (result.action === 'error') throw rowError(result);
      const id = result.contactId;
      let changed = false;
      // Borrar un dato (valor vacío o null) y quitar etiquetas: las mismas funciones componibles, en la misma transacción.
      if (data.attrs.clear.length) {
        const cleared = attributes().set(
          brandId,
          id,
          data.attrs.clear.map(k => ({ key: k, value: null })),
          { source: 'api', sourceId: key.id, actorId: actor.id, revealPersonal: reveal },
        );
        if (cleared.changed.length) changed = true;
      }
      for (const name of data.tags.remove) {
        const tag = repo.tagByKey(brandId, norm(name));
        if (tag && contacts.removeTag(id, tag.id)) changed = true;
      }
      if (result.consent === 'kept_opt_out')
        warnings.push({
          code: 'consent_locked',
          message: 'Esta persona pidió no recibir mensajes: la baja se conserva y la API no la levanta.',
        });
      const action = result.action === 'unchanged' && changed ? 'updated' : result.action;
      return { id, action, consent: result.consent, warnings };
    }

    const brief = (brandId, id) => {
      const c = repo.contact(brandId, id);
      return { id: c.id, updatedAt: c.updated_at };
    };
    function contactView(brandId, c) {
      const values = {};
      for (const [k, v] of Object.entries(attributes().read(brandId, c.id).values)) values[k] = v.value;
      const consent = contacts.consentOf(c.id);
      return {
        id: c.id,
        name: c.name,
        phone: c.phone || null,
        email: c.email || null,
        source: c.source,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        tags: repo.tags(brandId, c.id),
        attributes: values,
        consent: { status: consent.status, updatedAt: consent.updated_at ?? null },
      };
    }
    const contactOf = (brandId, id) => {
      const c = UUID.test(id ?? '') ? repo.contact(brandId, id) : null;
      if (!c) throw fail(404, 'Contacto no disponible.', { code: 'not_found' });
      return c;
    };

    // ---- rutas

    const handlers = {
      templates(ctx) {
        const templates = repo.templates(ctx.key.brand_id).map(row => {
          const def = definitionOf(row);
          return {
            id: row.id,
            name: row.name,
            language: row.language,
            category: row.category,
            status: row.status,
            quality: row.quality ?? null,
            body: def.body?.text ?? row.body,
            parameters: varsOf(def).map(v => ({
              key: v.key ?? null,
              where: v.where,
              ...(v.index !== undefined ? { index: v.index } : {}),
              example: v.sample || null,
              required: !v.fallback,
            })),
            header: { type: def.header?.type || 'none' },
            buttons: (def.buttons ?? []).map(b => ({ type: b.type, text: b.text ?? null })),
            updatedAt: row.updated_at,
          };
        });
        return { status: 200, body: { templates } };
      },
      lists(ctx) {
        return {
          status: 200,
          body: {
            lists: repo.lists(ctx.key.brand_id).map(a => ({
              id: a.id,
              name: a.name,
              role: a.role,
              memberCount: a.member_count,
              updatedAt: a.updated_at,
            })),
          },
        };
      },
      contact(ctx) {
        const brandId = ctx.key.brand_id;
        return { status: 200, body: { contact: contactView(brandId, contactOf(brandId, ctx.params[0])) } };
      },
      lookup(ctx) {
        const brandId = ctx.key.brand_id;
        const { phone, countryCode, email } = ctx.input;
        const extra = Object.keys(ctx.input).find(k => !['phone', 'countryCode', 'email'].includes(k));
        if (extra) throw bad(`El campo «${extra}» no se reconoce en esta ruta.`, extra);
        let found = null;
        if (typeof phone === 'string' && phone.trim()) {
          const p = canonicalPhone(phone.slice(0, 60), countryOptions(countryCode));
          if (!p.key) throw fail(422, p.message, { code: 'phone_invalid', field: 'phone' });
          found = repo.contactByPhoneKey(brandId, p.key);
        } else if (typeof email === 'string' && EMAIL.test(email.trim()))
          found = repo.contactByEmail(brandId, email.trim().toLowerCase());
        else throw bad('Busca por teléfono (phone) o por correo (email).', 'phone');
        if (!found) throw fail(404, 'No hay un contacto con ese dato en la marca.', { code: 'not_found' });
        return { status: 200, body: { contact: contactView(brandId, found) } };
      },
      upsert(ctx) {
        const out = writeContact(ctx, contactData(ctx.input, UPSERT_FIELDS));
        return {
          status: out.action === 'created' ? 201 : 200,
          entity: out.id,
          body: {
            contact: { ...brief(ctx.key.brand_id, out.id), created: out.action === 'created' },
            result: out.action,
            consent: out.consent,
            warnings: out.warnings,
          },
        };
      },
      batch(ctx) {
        const items = ctx.input.contacts;
        const extra = Object.keys(ctx.input).find(k => k !== 'contacts');
        if (extra) throw bad(`El campo «${extra}» no se reconoce en esta ruta.`, extra);
        if (!Array.isArray(items) || !items.length || items.length > LIMITS.batch)
          throw bad(`«contacts» es una lista de 1 a ${LIMITS.batch} contactos.`, 'contacts');
        // Cada fila es independiente: su propio punto de guardado dentro de la transacción de la petición.
        const results = items.map((item, index) => {
          db.exec('SAVEPOINT api_row');
          try {
            if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad('Cada fila es un objeto.', null);
            const out = writeContact(ctx, contactData(item, UPSERT_FIELDS));
            db.exec('RELEASE api_row');
            return {
              index,
              id: out.id,
              created: out.action === 'created',
              result: out.action,
              ...(out.warnings.length ? { warnings: out.warnings } : {}),
            };
          } catch (error) {
            db.exec('ROLLBACK TO api_row');
            db.exec('RELEASE api_row');
            if (!error?.status) throw error;
            return {
              index,
              error: {
                code: error.code ?? 'invalid_request',
                status: error.status,
                message: error.message,
                ...(error.field ? { field: error.field } : {}),
              },
            };
          }
        });
        return { status: 200, units: items.length, body: { results } };
      },
      patch(ctx) {
        const brandId = ctx.key.brand_id;
        const contact = contactOf(brandId, ctx.params[0]);
        const { expectedUpdatedAt } = ctx.input;
        if (expectedUpdatedAt !== undefined && !Number.isInteger(expectedUpdatedAt))
          throw bad('«expectedUpdatedAt» es la fecha updatedAt (en milisegundos) que leíste.', 'expectedUpdatedAt');
        if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== contact.updated_at)
          throw fail(409, 'El contacto cambió desde que lo leíste. Vuelve a leerlo.', {
            code: 'stale_revision',
            details: { updatedAt: contact.updated_at },
          });
        const data = contactData(ctx.input, PATCH_FIELDS);
        const warnings = [];
        if (data.phone?.trim()) {
          const p = canonicalPhone(data.phone, countryOptions(data.countryCode));
          if (!p.key) throw fail(422, p.message, { code: 'phone_invalid', field: 'phone' });
          if (contact.phone_key && contact.phone_key !== p.key) {
            // El teléfono de un contacto no se reescribe (identidad y conversaciones cuelgan de él).
            warnings.push({ code: 'phone_kept', message: 'El contacto ya tiene otro teléfono; no se cambió.' });
            data.phone = undefined;
          } else if (!contact.phone_key) {
            const other = repo.contactByPhoneKey(brandId, p.key);
            if (other && other.id !== contact.id)
              throw fail(409, 'Ese teléfono ya es de otro contacto de la marca.', {
                code: 'phone_in_use',
                field: 'phone',
              });
          }
        }
        const out = writeContact(ctx, data, contact.id);
        return {
          status: 200,
          entity: out.id,
          body: {
            contact: brief(brandId, out.id),
            result: out.action,
            warnings: [...warnings, ...out.warnings],
          },
        };
      },
      tags(ctx) {
        const brandId = ctx.key.brand_id;
        const contact = contactOf(brandId, ctx.params[0]);
        const extra = Object.keys(ctx.input).find(k => !['add', 'remove'].includes(k));
        if (extra) throw bad('Esta ruta admite sólo add y remove.', extra);
        const out = writeContact(ctx, { ...contactData({}, PATCH_FIELDS), tags: tagsOf(ctx.input) }, contact.id);
        return { status: 200, entity: out.id, body: { tags: repo.tags(brandId, out.id), result: out.action } };
      },
      consent(ctx) {
        const brandId = ctx.key.brand_id;
        const contact = contactOf(brandId, ctx.params[0]);
        const value = consentOf(ctx.input);
        if (!value) throw bad('Falta { status, source }.', 'status');
        const out = writeContact(ctx, { ...contactData({}, PATCH_FIELDS), consent: value }, contact.id);
        if (out.consent === 'kept_opt_out')
          throw fail(409, 'Esta persona pidió no recibir mensajes: la API no puede levantar una baja.', {
            code: 'consent_locked',
          });
        const current = contacts.consentOf(out.id);
        return {
          status: 200,
          entity: out.id,
          body: { consent: { status: current.status, updatedAt: current.updated_at ?? null }, result: out.action },
        };
      },
      listAdd(ctx) {
        const brandId = ctx.key.brand_id;
        const extra = Object.keys(ctx.input).find(k => k !== 'contactIds');
        if (extra) throw bad(`El campo «${extra}» no se reconoce en esta ruta.`, extra);
        const ids = ctx.input.contactIds;
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > LIMITS.listAdd ||
          ids.some(id => typeof id !== 'string' || !UUID.test(id))
        )
          throw bad(`«contactIds» es una lista de 1 a ${LIMITS.listAdd} identificadores de contacto.`, 'contactIds');
        const unique = [...new Set(ids)];
        const known = repo.knownContacts(brandId, unique);
        const out = audiences().addContacts(brandId, ctx.params[0], known, {
          source: 'api',
          sourceRef: ctx.key.id,
          actorId: ctx.actor.id,
        });
        return {
          status: 200,
          entity: ctx.params[0],
          units: unique.length,
          body: { added: out.added, refused: out.refused, unknown: unique.filter(id => !known.includes(id)) },
        };
      },
    };

    // ---- idempotencia y registro

    function record(ctx, fields) {
      repo.insert({
        id: ctx.requestId,
        keyId: ctx.key.id,
        brandId: ctx.key.brand_id,
        actorId: ctx.actor?.id,
        method: ctx.method,
        route: ctx.route.pattern,
        at: now(),
        ...fields,
      });
    }
    function dispatch(ctx) {
      const run = handlers[ctx.route.name];
      if (ctx.route.kind === 'read') return run(ctx);
      const started = now();
      try {
        return host.transaction(db, () => {
          if (ctx.idemKey) {
            const previous = repo.findIdem(ctx.key.id, ctx.idemKey);
            if (previous && previous.response !== null && previous.created_at > now() - IDEM_TTL_MS) {
              if (previous.request_hash !== ctx.hash)
                throw fail(409, 'Esta Idempotency-Key ya se usó con otra petición. Usa una clave nueva.', {
                  code: 'idempotency_key_reused',
                });
              return { status: previous.status, body: JSON.parse(previous.response), replayed: true };
            }
            if (previous) repo.releaseIdem(previous.id);
          }
          const out = run(ctx);
          record(ctx, {
            idemKey: ctx.idemKey,
            hash: ctx.hash,
            status: out.status,
            entityKind: ctx.route.name === 'listAdd' ? 'audience' : out.entity ? 'contact' : null,
            entityId: out.entity ?? null,
            units: out.units ?? 1,
            response: JSON.stringify(out.body),
            durationMs: now() - started,
          });
          host.audit(ctx.actor, ctx.route.action, out.entity ?? ctx.requestId);
          return out;
        });
      } catch (error) {
        // El intento fallido también queda (sin clave de idempotencia: corregido, se puede reintentar con la misma).
        if (error?.status && error.code !== 'idempotency_key_reused')
          try {
            record(ctx, { status: error.status, code: error.code ?? null, durationMs: now() - started });
          } catch {
            // el registro de un fallo nunca tapa el fallo
          }
        throw error;
      }
    }

    integrations.useWriter({
      routes: ROUTES,
      dispatch,
      limits: { batchMax: LIMITS.batch, listAddMax: LIMITS.listAdd },
    });

    return {
      async handle() {
        return false; // sin rutas con sesión: las llaves se administran en /api/integrations
      },
      purge: () => repo.purge(now()),
      dispatch,
    };
  },
  timers: [{ name: 'limpieza', everyMs: 3_600_000, testEveryMs: 500, run: api => api.purge() }],
};
