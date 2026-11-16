// Capa de compatibilidad con el proveedor anterior de WhatsApp (docs/PLAN_API_ENVIO.md; diseño de identidad y API
// §4.9; incremento I-8). Para que el sistema de recordatorios cambie sólo la dirección base y la llave.
//
// Sólo las dos formas de ENVIAR una plantilla que usa hoy ese sistema; lo demás (contactos, leer plantillas) tiene su
// ruta nativa y no se copia aquí hasta que el responsable diga que lo usa (preguntas abiertas en el plan):
//   POST /api/compat[/<cuenta>]/api/v1/sendTemplateMessage?whatsappNumber=<teléfono>
//        {template_name, broadcast_name?, parameters:[{name, value}]}  → {result, info, id, status}
//   POST /api/compat/api/ext/v3/messageTemplates/send
//        {template_name, broadcast_name?, recipients:[{phone_number, custom_params?:[{name, value}], local_message_id?}]}
//        → {success, broadcast_id, recipients:[{phone_number, local_message_id, success, id?, status?, error?}]}
//
// Cada destinatario se traduce a POST /api/v1/messages/template con integrations.invoke: misma llave, mismos permisos,
// mismos límites, misma idempotencia y mismo registro que una llamada directa. Como el proveedor anterior no tenía
// idempotencia, la clave se deriva del contenido (ruta, teléfono, plantilla, parámetros, broadcast_name y
// local_message_id) y vale API_COMPAT_DEDUPE_SECONDS (10 minutos por omisión): un reintento idéntico en ese lapso no
// duplica. Además, el motor no manda la misma plantilla con la misma etiqueta a la misma persona dos veces el mismo día.
//
// Apagada por omisión: hace falta API_COMPAT=1 en el entorno Y una llave con el permiso `compat` (además de
// `messages_send_template`). Apagada responde 404. La ruta heredada lleva el teléfono en la dirección (así la usa ese
// sistema): queda en los registros del proxy; por eso es un puente que se retira cuando deje de usarse.
import { createHmac } from 'node:crypto';
import { loadPeerKey } from '../../lib/peer-key.mjs';
import { SEND_ROUTE } from './send.mjs';

const LEGACY = /^\/api\/compat(?:\/[A-Za-z0-9_-]{1,64})?\/api\/v1\/sendTemplateMessage$/;
const BULK = /^\/api\/compat\/api\/ext\/v3\/messageTemplates\/send$/;
const MAX_RECIPIENTS = 100;
const BODY_BYTES = 256 * 1024;

export function createCompat(host) {
  const env = process.env;
  const integrations = host.services.integrations;
  // La clave de duplicados lleva el teléfono: se deriva con la llave de la instalación (server/lib/peer-key.mjs), no
  // con un SHA-256 a secas, que se revierte probando números.
  const peerKey = loadPeerKey({ env, dataDir: host.dataDir });
  const sha = v => createHmac('sha256', peerKey).update(v).digest('hex');
  const on = () => env.API_COMPAT === '1';
  const ttlMs = () => Math.max(1, Number(env.API_COMPAT_DEDUPE_SECONDS) || 600) * 1000;
  const send = (res, status, payload, headers = {}) => {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    host.json(res, status, payload);
  };

  async function readBody(req) {
    const type = String(req.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (type !== 'application/json')
      throw host.fail(415, 'Manda el cuerpo como JSON.', { code: 'unsupported_media_type' });
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_BYTES) throw host.fail(413, 'El cuerpo es demasiado grande.', { code: 'payload_too_large' });
      chunks.push(chunk);
    }
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (input && typeof input === 'object' && !Array.isArray(input)) return input;
    } catch {
      // abajo
    }
    throw host.fail(400, 'El cuerpo no es JSON válido.', { code: 'invalid_json' });
  }

  // [{name, value}] → { nombre: valor } (la ruta nativa valida nombres, valores y cuántos).
  const paramsOf = list =>
    Array.isArray(list)
      ? list.map(p => ({ name: p?.name, value: p?.value ?? '' }))
      : list === undefined || list === null
        ? []
        : list;
  // broadcast_name → etiqueta del CRM (letras, números, - y _; hasta 40).
  const labelOf = v =>
    String(v ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, '-')
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 40) || 'api';

  // Un destinatario: la llamada nativa con su clave derivada. Devuelve {ok, out} o {ok:false, error}.
  function one(req, res, ip, route, { phone, template, parameters, label, localId }) {
    const input = {
      to: { phone: typeof phone === 'string' || typeof phone === 'number' ? String(phone) : '' },
      template: { name: typeof template === 'string' ? template : '' },
      parameters: paramsOf(parameters),
      label,
    };
    const digits = input.to.phone.replace(/\D/g, '');
    const idemKey =
      'compat-' +
      sha(
        [route, digits, input.template.name, JSON.stringify(input.parameters), label, localId ?? ''].join('\n'),
      ).slice(0, 48);
    try {
      const out = integrations.invoke(req, res, ip, {
        method: 'POST',
        path: SEND_ROUTE,
        input,
        idemKey,
        idemTtlMs: ttlMs(),
        also: ['compat'],
      });
      res.setHeader('X-Request-Id', out.requestId);
      return { ok: true, out };
    } catch (error) {
      if (!error?.status) throw error;
      return { ok: false, error };
    }
  }
  const errorOf = e => ({
    code: e.code ?? 'invalid_request',
    message: e.message,
    ...(e.details ? { details: e.details } : {}),
  });
  const retry = e => (e.status === 429 ? { 'Retry-After': String(e.retryAfter || 60) } : {});

  async function handle(req, res, path, url, ip) {
    if (!on() || (!LEGACY.test(path) && !BULK.test(path))) {
      send(res, 404, { result: false, success: false, info: 'Ruta no encontrada.' });
      return true;
    }
    if (req.method !== 'POST') {
      send(res, 405, { result: false, success: false, info: 'Esta ruta sólo admite POST.' }, { Allow: 'POST' });
      return true;
    }
    if (LEGACY.test(path)) {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        send(res, error.status, { result: false, info: error.message, code: error.code });
        return true;
      }
      const r = one(req, res, ip, 'legacy', {
        phone: url.searchParams.get('whatsappNumber') ?? body.whatsappNumber,
        template: body.template_name,
        parameters: body.parameters,
        label: labelOf(body.broadcast_name),
      });
      if (r.ok)
        send(res, 200, {
          result: true,
          info: 'Mensaje aceptado.',
          id: r.out.body.send.id,
          status: r.out.body.send.status,
        });
      else send(res, r.error.status, { result: false, info: r.error.message, code: r.error.code }, retry(r.error));
      return true;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      send(res, error.status, { success: false, error: errorOf(error) });
      return true;
    }
    const list = body.recipients;
    if (!Array.isArray(list) || !list.length || list.length > MAX_RECIPIENTS) {
      send(res, 400, {
        success: false,
        error: { code: 'invalid_request', message: `«recipients» es una lista de 1 a ${MAX_RECIPIENTS} personas.` },
      });
      return true;
    }
    const label = labelOf(body.broadcast_name);
    const results = [];
    let stop = null;
    for (const item of list) {
      const phone = item?.phone_number ?? item?.whatsappNumber ?? '';
      const localId = typeof item?.local_message_id === 'string' ? item.local_message_id.slice(0, 100) : null;
      const echo = { phone_number: phone, ...(localId ? { local_message_id: localId } : {}) };
      if (stop) {
        results.push({
          ...echo,
          success: false,
          error: { code: 'not_processed', message: 'No se procesó: ' + stop.message },
        });
        continue;
      }
      const r = one(req, res, ip, 'bulk', {
        phone,
        template: body.template_name,
        parameters: item?.custom_params,
        label,
        localId,
      });
      if (r.ok) results.push({ ...echo, success: true, id: r.out.body.send.id, status: r.out.body.send.status });
      else {
        results.push({ ...echo, success: false, error: errorOf(r.error) });
        // Llave inválida, sin permiso o un límite: los demás correrían igual; se cortan aquí.
        if ([401, 403, 429].includes(r.error.status)) stop = r.error;
      }
    }
    const accepted = results.some(r => r.success);
    if (!accepted && stop)
      send(res, stop.status, { success: false, error: errorOf(stop), recipients: results }, retry(stop));
    else send(res, 200, { success: accepted, broadcast_id: label, recipients: results });
    return true;
  }

  return { handle };
}
