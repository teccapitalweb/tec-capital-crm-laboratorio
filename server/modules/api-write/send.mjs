// Envío de una plantilla aprobada de WhatsApp a una persona por la API v1 (docs/PLAN_API_ENVIO.md; diseño de identidad
// y API §4.8; conciliación técnica, filas 13, 15, 37, 39 y 40; incremento I-8).
//
//   POST /api/v1/messages/template        (messages_send_template, Idempotency-Key obligatoria) → 202 {send}
//   GET  /api/v1/messages/template/{ref}  (messages_send_template) → el estado de un envío de ESTA llave
//
// No hay otro camino de envío: todo pasa por broadcasts.sendOne (campaña de origen API por etiqueta, plantilla, número
// y día) con `strict`, que juzga ya lo que el emisor juzgaría al enviar. Corre dentro de la transacción de la petición
// (dispatch de module.mjs): crear el contacto, encolar el envío y registrar la petición es una sola cosa, sin red.
//
// Lo que una llave que sólo envía NO puede deducir (la revisión de seguridad marcó este patrón en contactos):
//   · si un teléfono ya era contacto de la marca: un teléfono nuevo se da de alta en silencio y la respuesta es la
//     misma; el id del contacto y «created» sólo salen con el permiso de lectura `contacts`;
//   · por qué una persona no puede recibir: baja y lista de exclusión responden igual (`recipient_unavailable`), y en
//     el estado los motivos que hablan de la persona se agrupan en `not_allowed`.
// Lo que sí deduce, y el diseño lo acepta (§4.8 y §4.15.8): que esa persona no puede recibir mensajes de la marca, y
// con una plantilla de marketing, que aceptó recibirlos (sin aceptación no sale ninguna promoción).
import { canonicalPhone } from '../../lib/identity-keys.mjs';
import { LIMITS as KEY_LIMITS } from '../../integrations.mjs';
import { countryOptions } from '../contact-import/mapping.mjs';
import { definitionOf, varsOf } from '../wa-templates/definition.mjs';

export const SEND_ROUTE = '/api/v1/messages/template';
export const SEND_LIMITS = Object.freeze({ parameters: 10, valueChars: 200, labelChars: 40 });
const DAY = 86_400_000;
const UUID = /^[a-f0-9-]{36}$/;
const LABEL = /^[A-Za-z0-9_-]{1,40}$/;
const PARAM = /^[A-Za-z0-9_]{1,30}$/;
const USABLE = ['approved', 'flagged'];
const FIELDS = ['to', 'template', 'parameters', 'label', 'contact', 'numberId'];
// Motivos de «omitido» que hablan de la persona: una llave sin `contacts` sólo ve que no se le pudo enviar.
const PERSONAL_REASONS = new Set(['opted_out', 'no_consent', 'suppressed', 'excluded', 'recent_campaign', 'duplicate']);

export function createSender(host, repo) {
  const fail = (status, message, extra) => host.fail(status, message, extra);
  const bad = (message, field) => fail(400, message, { code: 'invalid_request', ...(field ? { field } : {}) });
  const broadcasts = () => host.module('broadcasts');
  const importer = () => host.module('contact-import');
  const integrations = host.services.integrations;
  const reveals = key => integrations.scopesOf(key).includes('contacts');
  const optional = name => {
    try {
      return host.module(name);
    } catch {
      return null;
    }
  };

  // ---- entrada
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  function only(v, fields, where) {
    const extra = Object.keys(v).find(k => !fields.includes(k));
    if (extra) throw bad(`«${where}${extra}» no se reconoce en esta ruta.`, where + extra);
  }
  function recipientOf(to) {
    if (!isObject(to)) throw bad('«to» es { phone } o { contactId }.', 'to');
    only(to, ['phone', 'countryCode', 'contactId', 'bsuid'], 'to.');
    if (to.bsuid !== undefined)
      throw bad('Enviar por identificador de usuario de WhatsApp todavía no está disponible.', 'to.bsuid');
    if (to.contactId !== undefined && to.phone !== undefined)
      throw bad('Usa «to.phone» o «to.contactId», no los dos.', 'to');
    if (typeof to.contactId === 'string') {
      if (!UUID.test(to.contactId))
        throw fail(404, 'Contacto no disponible.', { code: 'not_found', field: 'to.contactId' });
      return { contactId: to.contactId };
    }
    if (typeof to.phone !== 'string' || !to.phone.trim() || to.phone.length > 60)
      throw bad('Falta el teléfono («to.phone»).', 'to.phone');
    if (to.countryCode !== undefined && (typeof to.countryCode !== 'string' || to.countryCode.length > 8))
      throw bad('«to.countryCode» es texto corto, como MX o 52.', 'to.countryCode');
    const p = canonicalPhone(to.phone, countryOptions(to.countryCode));
    if (!p.key) throw fail(422, p.message, { code: 'phone_invalid', field: 'to.phone' });
    return { phone: to.phone, countryCode: to.countryCode, phoneKey: p.key };
  }
  // Los valores de las variables: { nombre: valor } o, como los manda el proveedor anterior, [{ name, value }].
  function parametersOf(v) {
    if (v === undefined || v === null) return {};
    const entries = Array.isArray(v)
      ? v.map((p, i) => {
          if (!isObject(p) || typeof p.name !== 'string')
            throw bad('Cada parámetro es { name, value }.', `parameters.${i}`);
          return [p.name, p.value];
        })
      : isObject(v)
        ? Object.entries(v)
        : null;
    if (!entries) throw bad('«parameters» es un objeto { nombre: valor }.', 'parameters');
    if (entries.length > SEND_LIMITS.parameters)
      throw bad(`Hasta ${SEND_LIMITS.parameters} parámetros por envío.`, 'parameters');
    const out = {};
    for (const [name, value] of entries) {
      if (!PARAM.test(name))
        throw bad('El nombre de un parámetro admite letras, números y _ (hasta 30).', 'parameters');
      if (!['string', 'number', 'boolean'].includes(typeof value) || String(value).length > SEND_LIMITS.valueChars)
        throw bad(
          `El valor de «${name}» es texto de hasta ${SEND_LIMITS.valueChars} caracteres.`,
          'parameters.' + name,
        );
      out[name.toLowerCase()] = String(value);
    }
    return out;
  }
  function inputOf(input) {
    only(input, FIELDS, '');
    if (input.label !== undefined && (typeof input.label !== 'string' || !LABEL.test(input.label)))
      throw bad('«label» admite letras, números, - y _ (hasta 40).', 'label');
    if (input.contact !== undefined) {
      if (!isObject(input.contact)) throw bad('«contact» es { name }.', 'contact');
      only(input.contact, ['name'], 'contact.');
    }
    const name = input.contact?.name;
    if (name !== undefined && (typeof name !== 'string' || name.trim().length < 2 || name.length > 100))
      throw bad('«contact.name» es texto de 2 a 100 caracteres.', 'contact.name');
    if (
      input.numberId !== undefined &&
      input.numberId !== null &&
      (typeof input.numberId !== 'string' || input.numberId.length > 40)
    )
      throw bad('«numberId» es el identificador de un número de WhatsApp de la marca.', 'numberId');
    return {
      to: recipientOf(input.to),
      template: input.template,
      values: parametersOf(input.parameters),
      label: input.label ?? 'api',
      name: name?.trim(),
      numberId: input.numberId ?? null,
    };
  }

  // ---- plantilla y número
  function templateOf(brandId, ref) {
    if (!isObject(ref)) throw bad('«template» es { name, language } o { id }.', 'template');
    only(ref, ['id', 'name', 'language'], 'template.');
    let row = null;
    if (ref.id !== undefined) {
      if (typeof ref.id !== 'string' || !UUID.test(ref.id)) throw bad('«template.id» no es válido.', 'template.id');
      row = repo.templateById(brandId, ref.id);
    } else {
      if (typeof ref.name !== 'string' || !ref.name.trim() || ref.name.length > 512)
        throw bad('Falta el nombre de la plantilla («template.name»).', 'template.name');
      if (ref.language !== undefined && (typeof ref.language !== 'string' || ref.language.length > 15))
        throw bad('«template.language» es un código como es_MX.', 'template.language');
      const rows = repo.templatesByName(brandId, ref.name.trim());
      const fit = ref.language ? rows.filter(r => r.language === ref.language) : rows;
      if (fit.length > 1)
        throw fail(422, 'Esa plantilla existe en varios idiomas: indica «template.language».', {
          code: 'invalid_request',
          field: 'template.language',
          details: { languages: fit.map(r => r.language) },
        });
      row = fit[0] ?? null;
    }
    // La de otra marca responde igual que una que no existe.
    if (!row) throw fail(404, 'Plantilla no disponible en la marca.', { code: 'not_found', field: 'template' });
    if (!USABLE.includes(row.status))
      throw fail(422, 'La plantilla no está aprobada por Meta.', {
        code: 'template_not_approved',
        field: 'template',
        details: { status: row.status },
      });
    return row;
  }
  function numberOf(key, wanted) {
    const brandId = key.brand_id;
    let id = wanted ?? key.default_number_id ?? null;
    if (!id) {
      const enabled = repo.enabledNumbers(brandId);
      if (enabled.length !== 1)
        throw fail(422, 'La marca tiene varios números (o ninguno): indica «numberId» o fija el de la llave.', {
          code: 'number_required',
          field: 'numberId',
        });
      id = enabled[0].phone_number_id;
    }
    const number = repo.number(brandId, String(id));
    if (!number?.enabled)
      throw fail(409, 'Ese número de WhatsApp no está activo en la marca.', {
        code: 'number_unavailable',
        field: 'numberId',
        details: { reason: number ? 'number_paused' : 'not_found' },
      });
    return number;
  }
  // Modo escucha (I-11, otro frente): si existe la función que lo dice, un número en escucha sólo escribe a su lista
  // de prueba. Contrato que se espera: listenOnly('wa:' + phone_number_id, phoneKey) → true si NO se puede enviar.
  function listenBlocks(numberId, phoneKey) {
    for (const source of [host.services.whatsapp, optional('channel-health')]) {
      const fn = source?.listenOnly;
      if (typeof fn === 'function') return fn('wa:' + numberId, phoneKey ?? null) === true;
    }
    return false;
  }

  // ---- el tope diario de la llave (además del límite de 24 horas del número, que mira el motor)
  function checkDaily(key, at) {
    const limit = key.daily_send_limit ?? KEY_LIMITS.sendDailyDefault;
    const used = repo.sendsSince(key.brand_id, key.id, SEND_ROUTE, at - DAY);
    if (used.n >= limit)
      throw Object.assign(
        fail(429, `Esta llave llegó a su tope de ${limit} envíos en 24 horas.`, {
          code: 'daily_send_limit',
          details: { limit },
        }),
        { retryAfter: Math.max(1, Math.ceil(((used.oldest ?? at) + DAY - at) / 1000)) },
      );
  }

  // ---- rutas
  function send(ctx, at) {
    const { key, actor } = ctx;
    const brandId = key.brand_id;
    const data = inputOf(ctx.input);
    const tpl = templateOf(brandId, data.template);
    // Sin `contacts`, el nombre guardado del contacto no cuenta: si la plantilla lo usa, lo manda quien llama. Así la
    // respuesta no cambia según el teléfono ya tuviera (o no) un contacto con nombre.
    if (!reveals(key)) {
      const missing = varsOf(definitionOf(tpl))
        .map(v => v.key)
        .filter(k => k === 'nombre' && !data.values.nombre);
      if (missing.length)
        throw fail(422, 'Faltan valores para la plantilla.', { code: 'template_params', details: { missing } });
    }
    const number = numberOf(key, data.numberId);
    checkDaily(key, at);
    let contactId = data.to.contactId ?? null;
    let created = false;
    if (contactId) {
      const contact = repo.contact(brandId, contactId);
      if (!contact) throw fail(404, 'Contacto no disponible.', { code: 'not_found', field: 'to.contactId' });
      if (listenBlocks(number.phone_number_id, contact.phone_key))
        throw fail(409, 'El número está en modo escucha.', { code: 'number_listen_only' });
    } else {
      if (listenBlocks(number.phone_number_id, data.to.phoneKey))
        throw fail(409, 'El número está en modo escucha.', { code: 'number_listen_only' });
      // Por teléfono: el contacto de la marca con esa clave o, si no hay, uno nuevo (§4.8 paso 4), por la tubería
      // única de la importación. Un contacto existente no se toca.
      const row = importer().applyRow(
        brandId,
        { phone: data.to.phone, countryCode: data.to.countryCode, name: data.name },
        {
          onExisting: 'skip',
          nameFallback: 'phone',
          actorId: actor.id,
          importId: key.id,
          label: key.name,
          consent: { mode: 'none' },
          source: 'api',
          allow: { edit: true, tags: false, consent: false, phone: false },
        },
      );
      if (row.action === 'error')
        throw fail(422, 'No se pudo usar ese teléfono.', {
          code: row.reason === 'phone_invalid' ? 'phone_invalid' : 'invalid_request',
          field: 'to.phone',
        });
      contactId = row.contactId;
      created = row.action === 'created';
    }
    let out;
    try {
      out = broadcasts().sendOne({
        brandId,
        contactId,
        waTemplateId: tpl.id,
        waNumber: number.phone_number_id,
        values: data.values,
        label: data.label,
        // Una referencia por petición: la idempotencia la da Idempotency-Key en la misma transacción.
        clientRef: 'api-' + ctx.requestId.replace(/^req_/, ''),
        actorId: actor.id,
        strict: true,
      });
    } catch (error) {
      // Las variables de la plantilla se nombran como las manda quien llama (sin «llamada.»).
      if (error?.code === 'template_params')
        error.details = { missing: (error.details?.missing ?? []).map(k => String(k).replace(/^llamada\./, '')) };
      if (error?.code === 'template_not_usable') error.code = 'template_not_approved';
      throw error;
    }
    host.services.events.publish({
      type: 'envio_api.aceptado',
      brandId,
      entityKind: 'api_send',
      entityId: out.id,
      payload: {
        sendId: out.id,
        apiKeyId: key.id,
        template: tpl.name,
        language: tpl.language,
        category: tpl.category,
        label: data.label,
      },
      actorId: actor.id,
      source: 'api',
      dedupeKey: 'envio_api.aceptado:' + out.id,
    });
    return {
      status: 202,
      entity: out.id,
      entityKind: 'send',
      body: {
        send: {
          id: out.id,
          status: out.state,
          label: data.label,
          template: { name: tpl.name, language: tpl.language },
          numberId: number.phone_number_id,
        },
        ...(reveals(key) ? { contact: { id: contactId, created } } : {}),
      },
    };
  }
  function status(ctx) {
    const { key } = ctx;
    const brandId = key.brand_id;
    const owner = repo.sendOwner(brandId, ctx.params[0]);
    // Sólo los envíos de esta llave (o de la que rotó en ella); los demás, como si no existieran.
    if (!owner || ![key.id, key.rotated_from].includes(owner.key_id))
      throw fail(404, 'Envío no disponible.', { code: 'not_found' });
    const s = broadcasts().sendStatus(brandId, ctx.params[0]);
    const reason = s.skipReason && !reveals(key) && PERSONAL_REASONS.has(s.skipReason) ? 'not_allowed' : s.skipReason;
    return {
      status: 200,
      body: {
        id: s.id,
        status: s.state,
        reason: reason ?? null,
        failCode: s.failCode ?? null,
        sentAt: s.sentAt ?? null,
        deliveredAt: s.deliveredAt ?? null,
        readAt: s.readAt ?? null,
        failedAt: s.failedAt ?? null,
        repliedAt: s.repliedAt ?? null,
        ...(reveals(key) ? { contactId: s.contactId } : {}),
      },
    };
  }

  // Avisos de Meta (entregado, leído, fallido) de un envío hecho por la API: su evento, con la llave que lo hizo.
  // Corre después del oyente de difusiones (order 200), que ya asentó el estado.
  function onStatus(data) {
    const ref = typeof data?.providerRef === 'string' ? data.providerRef.slice(0, 200) : '';
    if (!ref || !['sent', 'delivered', 'read', 'failed'].includes(data?.state)) return null;
    const r = repo.recipientByRef(ref);
    if (!r || r.state !== data.state) return null;
    const owner = repo.sendByRecipient(r.id);
    if (!owner) return null;
    host.services.events.publish({
      type: 'envio_api.estado',
      brandId: owner.brand_id,
      entityKind: 'api_send',
      entityId: r.id,
      payload: { sendId: r.id, apiKeyId: owner.key_id, state: r.state, failCode: r.fail_code ?? null },
      source: 'api',
      dedupeKey: `envio_api.estado:${r.id}:${r.state}`,
    });
    return 'api: envío ' + r.state;
  }

  return { send, status, onStatus };
}

export const SEND_EVENT_TYPES = {
  'envio_api.aceptado': {
    title: 'La API aceptó un envío de plantilla',
    entity: 'api_send',
    payload: 'sendId, apiKeyId, template, language, category, label',
  },
  'envio_api.estado': {
    title: 'Cambió el estado de un envío hecho por la API',
    entity: 'api_send',
    payload: 'sendId, apiKeyId, state, failCode',
  },
};
