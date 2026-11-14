// Meta de mentira para las pruebas de punta a punta: la Graph API mínima que usa el CRM (enviar un mensaje, leer los
// datos de un archivo y descargarlo), con dos mandos para las pruebas de trabajo duradero:
//   hold('send' | 'download')  las peticiones de ese tipo se quedan sin respuesta hasta release(…): así un envío o
//                              una descarga se queda «en vuelo» todo el tiempo que la prueba necesite.
//   delays.send                milisegundos que tarda en responder un envío.
// Y los webhooks que manda Meta, con lo que lee el contrato de canal 1.1 (docs/PLAN_CONTRATO_CANAL.md): entrantes con
// identificador de usuario, mensaje citado, botón de plantilla o reacción (metaInbound), estados con tarificación y
// código de fallo (metaStatus) y avisos de cuenta, número, plantilla y preferencias (metaNotice). Es el único Meta de
// mentira para lo nuevo; las pruebas antiguas que montan su propio servidor se quedan como están.
// Nada sale a internet y todos los datos son inventados.
import { createServer } from 'node:http';
import { hmacHex } from '../../server/connectors.mjs';

export const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 7)]);
export const TOKEN = 'EAAprueba0000000000000000000000token';
export const SECRET = 'app-secret-prueba';
export const NUMBER = '109000000000001';

// Cuentas de WhatsApp Business de mentira (sólo dígitos, como META_WABA_ID) y la app (META_APP_ID).
export const WABA_ID = '209000000000001';
export const WABA_ID_2 = '209000000000002';
export const APP_ID = '309000000000001';

export async function startFakeMeta() {
  const sent = [];
  const downloads = [];
  const delays = { send: 0 };
  const held = { send: [], download: [] };
  const holding = { send: false, download: false };
  let n = 0;
  // Plantillas por cuenta (D-3): listar por páginas, crear, corregir, borrar, y la subida por sesión de la muestra.
  const templates = new Map(); // waba → [plantilla como la devuelve Meta]
  const created = []; // cuerpos de las altas, en orden
  const edited = []; // {id, body}
  const deleted = []; // {waba, name, hsmId}
  const uploads = []; // {kind:'session'|'sample'|'media', …}
  const listCalls = []; // {waba, after, limit}
  let tid = 0;
  const accountOf = waba => {
    if (!templates.has(waba)) templates.set(waba, []);
    return templates.get(waba);
  };
  const gate = (kind, respond) => {
    if (holding[kind]) held[kind].push(respond);
    else respond();
  };
  const server = createServer((req, res) => {
    const chunks = [];
    // quien pidió pudo morir con la petición en vuelo (es justo lo que ensayan las pruebas): no es un error del Meta de mentira
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const send = (status, data) => {
        if (res.destroyed) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      let match;
      // segundo paso de la subida por sesión: los bytes, con «OAuth <token>» y file_offset
      if ((match = url.pathname.match(/^\/v25\.0\/(upload:[A-Za-z0-9]+)$/)) && req.method === 'POST') {
        if (req.headers.authorization !== 'OAuth ' + TOKEN || req.headers.file_offset !== '0')
          return send(401, { error: { code: 190, message: 'Invalid OAuth access token' } });
        const raw = Buffer.concat(chunks);
        uploads.push({ kind: 'sample', session: match[1], bytes: raw.length, type: req.headers['content-type'] });
        return send(200, { h: '4::handle-' + uploads.length });
      }
      if (req.headers.authorization !== 'Bearer ' + TOKEN)
        return send(401, { error: { code: 190, message: 'Invalid OAuth access token' } });
      if ((match = url.pathname.match(/^\/v25\.0\/(\d+)\/message_templates$/))) {
        const list = accountOf(match[1]);
        if (req.method === 'GET') {
          const limit = Math.min(100, Number(url.searchParams.get('limit')) || 25);
          const after = Number(url.searchParams.get('after') || 0);
          listCalls.push({ waba: match[1], after, limit });
          const page = list.slice(after, after + limit);
          const more = after + limit < list.length;
          return send(200, {
            data: page,
            paging: {
              cursors: { before: String(after), after: String(after + limit) },
              ...(more ? { next: 'x' } : {}),
            },
          });
        }
        if (req.method === 'POST') {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          created.push(body);
          const id = String(900000 + ++tid);
          list.push({
            id,
            name: body.name,
            language: body.language,
            status: 'PENDING',
            category: body.category,
            components: body.components,
          });
          return send(200, { id, status: 'PENDING', category: body.category });
        }
        if (req.method === 'DELETE') {
          const name = url.searchParams.get('name');
          const hsmId = url.searchParams.get('hsm_id');
          deleted.push({ waba: match[1], name, hsmId });
          templates.set(
            match[1],
            list.filter(t => !(t.name === name && (!hsmId || t.id === hsmId))),
          );
          return send(200, { success: true });
        }
      }
      if ((match = url.pathname.match(/^\/v25\.0\/(\d+)\/uploads$/)) && req.method === 'POST') {
        uploads.push({
          kind: 'session',
          app: match[1],
          length: Number(url.searchParams.get('file_length')),
          type: url.searchParams.get('file_type'),
        });
        return send(200, { id: 'upload:sesion' + uploads.length });
      }
      if ((match = url.pathname.match(/^\/v25\.0\/(\d+)\/media$/)) && req.method === 'POST') {
        uploads.push({ kind: 'media', from: match[1], bytes: Buffer.concat(chunks).length });
        return send(200, { id: 'media-' + uploads.length });
      }
      if ((match = url.pathname.match(/^\/v25\.0\/(\d+)$/)) && req.method === 'POST') {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        edited.push({ id: match[1], body });
        for (const list of templates.values())
          for (const t of list)
            if (t.id === match[1]) Object.assign(t, { status: 'PENDING', components: body.components ?? t.components });
        return send(200, { success: true });
      }
      if ((match = url.pathname.match(/^\/download\/(\d+)$/))) {
        downloads.push(match[1]);
        return gate('download', () => {
          if (res.destroyed) return;
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(PNG);
        });
      }
      if ((match = url.pathname.match(/^\/v25\.0\/(\d+)\/messages$/)) && req.method === 'POST') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        sent.push({ from: match[1], ...body });
        const id = 'wamid.out' + ++n;
        return gate('send', () =>
          setTimeout(
            () => send(200, { messaging_product: 'whatsapp', contacts: [{ wa_id: body.to }], messages: [{ id }] }),
            delays.send,
          ),
        );
      }
      if ((match = url.pathname.match(/^\/v25\.0\/(\d+)$/)) && req.method === 'GET') {
        if (match[1] === NUMBER)
          return send(200, { display_phone_number: '+1 555 010 0000', verified_name: 'Test Number', id: NUMBER });
        // cualquier otro identificador numérico es un archivo que la persona envió
        return send(200, {
          url: 'http://127.0.0.1:' + server.address().port + '/download/' + match[1],
          mime_type: 'image/png',
          file_size: PNG.length,
          id: match[1],
        });
      }
      send(404, { error: { code: 100, message: 'ruta desconocida' } });
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + server.address().port;
  return {
    url,
    sent,
    downloads,
    delays,
    hold(kind) {
      holding[kind] = true;
    },
    release(kind) {
      holding[kind] = false;
      for (const respond of held[kind].splice(0)) respond();
    },
    waiting: kind => held[kind].length,
    // plantillas de cada cuenta (como las devuelve Meta) y lo que el CRM les hizo
    templates: accountOf,
    created,
    edited,
    deleted,
    uploads,
    listCalls,
    // Variables de entorno de un servidor con WhatsApp real completo, apuntando a este Meta de mentira.
    env: {
      CHANNEL_CONNECTOR: 'meta',
      META_ACCESS_TOKEN: TOKEN,
      META_APP_SECRET: SECRET,
      META_VERIFY_TOKEN: 'verifica-123',
      META_PHONE_NUMBER_ID: NUMBER,
      META_GRAPH_URL: url,
      META_GRAPH_VERSION: '',
      AI_PROVIDER: '',
    },
    close: () =>
      new Promise(done => {
        for (const kind of ['send', 'download']) held[kind].length = 0;
        server.closeAllConnections();
        server.close(done);
      }),
  };
}

// Cuerpo de un webhook como lo manda Meta: una entrada de la cuenta WABA con un cambio. `value` es el contenido de
// entry[].changes[].value; `field` el campo («messages» o un aviso de cuenta, número o plantilla).
export const WABA = 'waba';
export const metaBody = (value, { field = 'messages', entryId = WABA, time } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: entryId,
      ...(time ? { time } : {}),
      changes: [{ field, value: field === 'messages' ? { messaging_product: 'whatsapp', ...value } : value }],
    },
  ],
});

// Un webhook firmado como lo manda Meta.
export async function metaHook(origin, value, { secret = SECRET, field, entryId, time } = {}) {
  const raw = JSON.stringify(metaBody(value, { field, entryId, time }));
  const response = await fetch(origin + '/api/webhooks/channel/meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=' + hmacHex(secret, raw) },
    body: raw,
  });
  return { status: response.status, body: await response.json() };
}

// Lo de un mensaje entrante (entry[].changes[].value). `message` es lo propio del tipo: {type:'text', text:{body}},
// {type:'image', image:{…}}, {type:'button', button:{text, payload}}, {type:'reaction', reaction:{…}}…
// Contrato 1.1: `bsuid` (identificador de usuario; con `from` vacío, la persona escribe sin teléfono visible),
// `username`, `replyTo` (wamid citado) y `forwarded`.
export function metaInboundValue(
  from,
  id,
  message,
  { to = NUMBER, name = 'Persona de prueba', bsuid, username, replyTo, forwarded } = {},
) {
  const context = {
    ...(replyTo ? { from: '15550100000', id: replyTo } : {}),
    ...(forwarded ? { forwarded: true } : {}),
  };
  return {
    metadata: { display_phone_number: '15550100000', phone_number_id: to },
    contacts: [
      {
        profile: { name, ...(username ? { username } : {}) },
        ...(from ? { wa_id: from } : {}),
        ...(bsuid ? { user_id: bsuid } : {}),
      },
    ],
    messages: [
      {
        ...(from ? { from } : {}),
        ...(bsuid ? { from_user_id: bsuid } : {}),
        id,
        timestamp: String(Math.floor(Date.now() / 1000)),
        ...(Object.keys(context).length ? { context } : {}),
        ...message,
      },
    ],
  };
}
export const metaInbound = (origin, from, id, message, options = {}) =>
  metaHook(origin, metaInboundValue(from, id, message, options));
export const metaText = (origin, from, id, body, options) =>
  metaInbound(origin, from, id, { type: 'text', text: { body } }, options);

// Un estado de un mensaje saliente (entry[].changes[].value.statuses[]). Contrato 1.1: `pricing` (como lo manda Meta:
// {billable, pricing_model, category, type}), `error` ({code, title, message, error_data:{details}}), `callback`
// (biz_opaque_callback_data) y el destinatario (`recipient`, sus dígitos; `recipientUserId`).
export function metaStatusValue(
  wamid,
  status,
  { to = NUMBER, recipient = '5215512345678', recipientUserId, pricing, error, callback, timestamp } = {},
) {
  return {
    metadata: { display_phone_number: '15550100000', phone_number_id: to },
    statuses: [
      {
        id: wamid,
        status,
        timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
        ...(recipient ? { recipient_id: recipient } : {}),
        ...(recipientUserId ? { recipient_user_id: recipientUserId } : {}),
        ...(pricing ? { pricing } : {}),
        ...(error ? { errors: [error] } : {}),
        ...(callback ? { biz_opaque_callback_data: callback } : {}),
      },
    ],
  };
}
export const metaStatus = (origin, wamid, status, options) => metaHook(origin, metaStatusValue(wamid, status, options));
// Tarificación por mensaje como la informa Meta desde julio de 2025.
export const metaPricing = (category, { billable = true, type = 'regular' } = {}) => ({
  billable,
  pricing_model: 'PMP',
  category,
  type,
});

// Un aviso de cuenta, número o plantilla (change.field distinto de «messages»), con su instante de entrada.
export const metaNotice = (origin, field, value, { time = Math.floor(Date.now() / 1000) } = {}) =>
  metaHook(origin, value, { field, time });
